/**
 * claude_code tool - Start a new Claude Code agent session
 */
import type { SessionManager } from "../session/manager.js";
import type {
  AgentDefinition,
  EffortLevel,
  McpServerConfig,
  SandboxSettings,
  Settings,
  SessionStartResult,
  SettingSource,
  ThinkingConfig,
  ToolConfig,
  PermissionMode,
  StructuredError,
} from "../types.js";
import { ErrorCode, DEFAULT_POLL_INTERVAL_RUNNING_MS } from "../types.js";
import { consumeQuery } from "./query-consumer.js";
import type { ToolDiscoveryCache } from "./tool-discovery.js";
import { computeResumeToken, getResumeSecret } from "../utils/resume-token.js";
import { raceWithAbort } from "../utils/race-with-abort.js";
import { buildOptions } from "../utils/build-options.js";
import { toSessionCreateParams } from "../session/create-params.js";
import {
  normalizeWindowsPathArray,
  normalizeWindowsPathLike,
} from "../utils/normalize-windows-path.js";
import { resolveExplicitClaudeExecutable } from "../utils/claude-executable.js";
import { normalizeAndAssertWorkingDirectory } from "../utils/working-directory.js";
import { validatePermissionMode } from "../utils/permission-mode.js";
import {
  classifySdkStartError,
  structuredError,
  toStructuredError,
} from "../utils/structured-error.js";

/**
 * Low-frequency / SDK-passthrough options grouped under `advanced`.
 */
export interface ClaudeCodeAdvancedOptions {
  tools?: string[] | { type: "preset"; preset: "claude_code" };
  persistSession?: boolean;
  sessionInitTimeoutMs?: number;
  agents?: Record<string, AgentDefinition>;
  agent?: string;
  maxBudgetUsd?: number;
  betas?: string[];
  additionalDirectories?: string[];
  outputFormat?: { type: "json_schema"; schema: Record<string, unknown> };
  pathToClaudeCodeExecutable?: string;
  mcpServers?: Record<string, McpServerConfig>;
  sandbox?: SandboxSettings;
  enableFileCheckpointing?: boolean;
  toolConfig?: ToolConfig;
  includePartialMessages?: boolean;
  promptSuggestions?: boolean;
  agentProgressSummaries?: boolean;
  strictMcpConfig?: boolean;
  settings?: string | Settings;
  strictAllowedTools?: boolean;
  settingSources?: SettingSource[];
  debug?: boolean;
  debugFile?: string;
  env?: Record<string, string | undefined>;
}

export interface ClaudeCodeInput {
  prompt: string;
  cwd?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  strictAllowedTools?: boolean;
  maxTurns?: number;
  model?: string;
  permissionMode?: PermissionMode;
  allowDangerouslySkipPermissions?: boolean;
  effort?: EffortLevel;
  thinking?: ThinkingConfig;
  systemPrompt?: string | { type: "preset"; preset: "claude_code"; append?: string };
  /** Timeout waiting for permission decision (default 60000ms) */
  permissionRequestTimeoutMs?: number;
  /** Low-frequency SDK options. All fields are optional and have sensible defaults. */
  advanced?: ClaudeCodeAdvancedOptions;
}

export type ClaudeCodeStartResult =
  | SessionStartResult
  | { sessionId: string; status: "error"; error: StructuredError };

export async function executeClaudeCode(
  input: ClaudeCodeInput,
  sessionManager: SessionManager,
  serverCwd: string,
  toolCache?: ToolDiscoveryCache,
  requestSignal?: AbortSignal
): Promise<ClaudeCodeStartResult> {
  const cwdProvided = input.cwd !== undefined;
  const cwd = cwdProvided ? input.cwd : serverCwd;

  if (typeof cwd !== "string" || cwd.trim() === "") {
    return {
      sessionId: "",
      status: "error",
      error: structuredError(ErrorCode.INVALID_ARGUMENT, "cwd must be a non-empty string."),
    };
  }
  let normalizedCwd: string;
  if (cwdProvided) {
    try {
      normalizedCwd = normalizeAndAssertWorkingDirectory(cwd, "cwd", "preserve");
    } catch (err: unknown) {
      if (!(err instanceof Error)) throw err;
      return {
        sessionId: "",
        status: "error",
        error: toStructuredError(err, ErrorCode.INTERNAL),
      };
    }
  } else {
    normalizedCwd = normalizeWindowsPathLike(cwd);
  }

  if (!sessionManager.hasCapacityFor(1)) {
    return {
      sessionId: "",
      status: "error",
      error: structuredError(
        ErrorCode.RESOURCE_EXHAUSTED,
        `Too many sessions (limit: ${sessionManager.getMaxSessions()}).`
      ),
    };
  }

  const abortController = new AbortController();
  const adv = input.advanced ?? {};

  const permissionRequestTimeoutMs = input.permissionRequestTimeoutMs ?? 60_000;
  const sessionInitTimeoutMs = adv.sessionInitTimeoutMs ?? 10_000;

  let permission: ReturnType<typeof validatePermissionMode>;
  try {
    permission = validatePermissionMode(
      input.permissionMode,
      input.allowDangerouslySkipPermissions
    );
  } catch (err: unknown) {
    return { sessionId: "", status: "error", error: toStructuredError(err, ErrorCode.INTERNAL) };
  }

  // Flatten top-level + advanced into a single object for buildOptions / sessionManager.
  const flat = {
    cwd: normalizedCwd,
    allowedTools: input.allowedTools,
    disallowedTools: input.disallowedTools,
    strictAllowedTools: input.strictAllowedTools ?? adv.strictAllowedTools,
    maxTurns: input.maxTurns,
    model: input.model,
    permissionMode: permission.permissionMode,
    allowDangerouslySkipPermissions: permission.allowDangerouslySkipPermissions,
    systemPrompt: input.systemPrompt,
    ...adv,
    effort: input.effort,
    thinking: input.thinking,
  };
  try {
    const normalizedFlat = {
      ...flat,
      additionalDirectories:
        flat.additionalDirectories !== undefined
          ? normalizeWindowsPathArray(flat.additionalDirectories)
          : undefined,
      debugFile:
        flat.debugFile !== undefined ? normalizeWindowsPathLike(flat.debugFile) : undefined,
      pathToClaudeCodeExecutable:
        flat.pathToClaudeCodeExecutable !== undefined
          ? resolveExplicitClaudeExecutable(flat.pathToClaudeCodeExecutable, normalizedCwd)
          : undefined,
    };

    const handle = consumeQuery({
      mode: "start",
      prompt: input.prompt,
      abortController,
      options: buildOptions(normalizedFlat),
      permissionRequestTimeoutMs,
      sessionInitTimeoutMs,
      sessionManager,
      toolCache,
      onInit: (init) => {
        // Idempotent: on transient retry the SDK may re-send init for the same session.
        if (sessionManager.get(init.session_id)) return;
        sessionManager.create(
          toSessionCreateParams({
            sessionId: init.session_id,
            source: normalizedFlat,
            permissionMode: permission.permissionMode,
            abortController,
            queryInterrupt: () => {
              handle.interrupt();
            },
          })
        );
      },
    });

    const sessionId = await raceWithAbort(handle.sdkSessionIdPromise, requestSignal, () =>
      abortController.abort()
    );

    const resumeSecret = getResumeSecret();
    const session = sessionManager.get(sessionId);
    return {
      sessionId,
      status: "running",
      pollInterval: DEFAULT_POLL_INTERVAL_RUNNING_MS,
      model: session?.model,
      claudeCodeVersion: session?.claudeCodeVersion,
      permissionMode: session?.permissionMode ?? permission.permissionMode,
      resumeToken: resumeSecret ? computeResumeToken(sessionId, resumeSecret) : undefined,
    };
  } catch (err: unknown) {
    return {
      sessionId: "",
      status: "error",
      error: classifySdkStartError(err, input.model),
    };
  }
}
