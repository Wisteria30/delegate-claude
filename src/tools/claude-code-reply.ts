/**
 * claude_code_reply tool - Continue an existing Claude Code session (async)
 */
import type { SessionManager } from "../session/manager.js";
import type {
  AgentDefinition,
  EffortLevel,
  McpServerConfig,
  OutputFormat,
  SandboxSettings,
  Settings,
  SessionStartResult,
  SettingSource,
  SystemPrompt,
  ThinkingConfig,
  ToolConfig,
  ToolsConfig,
} from "../types.js";
import { ErrorCode, DEFAULT_POLL_INTERVAL_RUNNING_MS } from "../types.js";
import { consumeQuery } from "./query-consumer.js";
import type { ToolDiscoveryCache } from "./tool-discovery.js";
import {
  computeResumeToken,
  getResumeSecret,
  getResumeSecrets,
  isValidResumeToken,
} from "../utils/resume-token.js";
import { raceWithAbort } from "../utils/race-with-abort.js";
import { buildOptions, normalizeOptionSourcePaths } from "../utils/build-options.js";
import type { OptionSource } from "../utils/build-options.js";
import { toSessionCreateParams } from "../session/create-params.js";
import { resolveExplicitClaudeExecutable } from "../utils/claude-executable.js";
import { normalizeAndAssertWorkingDirectory } from "../utils/working-directory.js";
import { toToolErrorText } from "../utils/tool-error.js";

/** Disk resume fallback configuration — only used when the in-memory session is missing. */
export interface DiskResumeConfig {
  resumeToken?: string;
  cwd?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  tools?: ToolsConfig;
  persistSession?: boolean;
  maxTurns?: number;
  model?: string;
  systemPrompt?: SystemPrompt;
  agents?: Record<string, AgentDefinition>;
  agent?: string;
  maxBudgetUsd?: number;
  effort?: EffortLevel;
  betas?: string[];
  additionalDirectories?: string[];
  outputFormat?: OutputFormat;
  thinking?: ThinkingConfig;
  resumeSessionAt?: string;
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

export interface ClaudeCodeReplyInput {
  sessionId: string;
  prompt: string;
  forkSession?: boolean;
  effort?: EffortLevel;
  thinking?: ThinkingConfig;

  /** Timeout waiting for fork init (default 10000ms, only used when forkSession=true) */
  sessionInitTimeoutMs?: number;
  /** Timeout waiting for permission decision (default 60000ms) */
  permissionRequestTimeoutMs?: number;

  /**
   * Disk resume fallback configuration. Only used when `CLAUDE_CODE_MCP_ALLOW_DISK_RESUME=1`
   * and the in-memory session is missing. Contains resumeToken + all session config overrides.
   */
  diskResumeConfig?: DiskResumeConfig;
}

export type ClaudeCodeReplyStartResult =
  | SessionStartResult
  | { sessionId: string; status: "error"; error: string };

function toStartError(
  sessionId: string,
  err: unknown
): {
  agentResult: {
    sessionId: string;
    result: string;
    isError: true;
    durationMs: 0;
    numTurns: 0;
    totalCostUsd: 0;
  };
  errorText: string;
} {
  const errorText = toToolErrorText(err);
  return {
    agentResult: {
      sessionId,
      result: errorText,
      isError: true,
      durationMs: 0,
      numTurns: 0,
      totalCostUsd: 0,
    },
    errorText,
  };
}

function buildDiskResumeSource(
  dr: DiskResumeConfig,
  overrides: Pick<ClaudeCodeReplyInput, "effort" | "thinking">
): OptionSource {
  if (dr.cwd === undefined || typeof dr.cwd !== "string" || dr.cwd.trim() === "") {
    throw new Error(`Error [${ErrorCode.INVALID_ARGUMENT}]: cwd must be provided for disk resume.`);
  }
  const normalizedCwd = normalizeAndAssertWorkingDirectory(dr.cwd, "disk resume cwd", "resolve");
  const pathToClaudeCodeExecutable =
    dr.pathToClaudeCodeExecutable !== undefined
      ? resolveExplicitClaudeExecutable(dr.pathToClaudeCodeExecutable, normalizedCwd)
      : undefined;
  // Drop the resume secret so it never reaches the session record or the SDK options.
  const { resumeToken: _resumeToken, ...source } = dr;
  void _resumeToken;
  const normalizedSource: OptionSource = {
    ...source,
    ...normalizeOptionSourcePaths(source),
    cwd: normalizedCwd,
    pathToClaudeCodeExecutable,
  };
  if (overrides.effort !== undefined) normalizedSource.effort = overrides.effort;
  if (overrides.thinking !== undefined) normalizedSource.thinking = overrides.thinking;
  return normalizedSource;
}

export async function executeClaudeCodeReply(
  input: ClaudeCodeReplyInput,
  sessionManager: SessionManager,
  toolCache?: ToolDiscoveryCache,
  requestSignal?: AbortSignal
): Promise<ClaudeCodeReplyStartResult> {
  const permissionRequestTimeoutMs = input.permissionRequestTimeoutMs ?? 60_000;
  const sessionInitTimeoutMs = input.sessionInitTimeoutMs ?? 10_000;

  const existing = sessionManager.get(input.sessionId);
  if (!existing) {
    if (!sessionManager.hasCapacityFor(1)) {
      return {
        sessionId: input.sessionId,
        status: "error",
        error: `Error [${ErrorCode.RESOURCE_EXHAUSTED}]: Too many sessions (limit: ${sessionManager.getMaxSessions()}).`,
      };
    }

    const allowDiskResume = process.env.CLAUDE_CODE_MCP_ALLOW_DISK_RESUME === "1";
    if (!allowDiskResume) {
      return {
        sessionId: input.sessionId,
        status: "error",
        error: `Error [${ErrorCode.SESSION_NOT_FOUND}]: Session '${input.sessionId}' not found or expired.`,
      };
    }

    const resumeSecrets = getResumeSecrets();
    const resumeSecret = resumeSecrets[0];
    if (!resumeSecret) {
      return {
        sessionId: input.sessionId,
        status: "error",
        error: `Error [${ErrorCode.PERMISSION_DENIED}]: Disk resume is enabled but CLAUDE_CODE_MCP_RESUME_SECRET is not set.`,
      };
    }

    const dr = input.diskResumeConfig ?? {};
    if (typeof dr.resumeToken !== "string" || dr.resumeToken.trim() === "") {
      return {
        sessionId: input.sessionId,
        status: "error",
        error: `Error [${ErrorCode.PERMISSION_DENIED}]: resumeToken is required for disk resume fallback.`,
      };
    }
    if (!isValidResumeToken(input.sessionId, dr.resumeToken, resumeSecrets)) {
      return {
        sessionId: input.sessionId,
        status: "error",
        error: `Error [${ErrorCode.PERMISSION_DENIED}]: Invalid resumeToken for session '${input.sessionId}'.`,
      };
    }

    try {
      const abortController = new AbortController();
      const source = buildDiskResumeSource(dr, input);
      const options = buildOptions(source);
      sessionManager.create(
        toSessionCreateParams({
          sessionId: input.sessionId,
          source,
          permissionMode: "default",
          abortController,
        })
      );

      try {
        const handle = consumeQuery({
          mode: "disk-resume",
          sessionId: input.sessionId,
          prompt: input.prompt,
          abortController,
          options,
          permissionRequestTimeoutMs,
          sessionInitTimeoutMs,
          sessionManager,
          toolCache,
        });
        sessionManager.update(input.sessionId, {
          queryInterrupt: () => {
            handle.interrupt();
          },
        });
      } catch (err: unknown) {
        const { agentResult, errorText } = toStartError(input.sessionId, err);
        sessionManager.setResult(input.sessionId, {
          type: "error",
          result: agentResult,
          createdAt: new Date().toISOString(),
        });
        sessionManager.pushEvent(input.sessionId, {
          type: "error",
          data: agentResult,
          timestamp: new Date().toISOString(),
        });
        sessionManager.update(input.sessionId, {
          status: "error",
          abortController: undefined,
          queryInterrupt: undefined,
        });
        return { sessionId: input.sessionId, status: "error", error: errorText };
      }

      return {
        sessionId: input.sessionId,
        status: "running",
        pollInterval: DEFAULT_POLL_INTERVAL_RUNNING_MS,
        resumeToken: computeResumeToken(input.sessionId, resumeSecret),
      };
    } catch (err: unknown) {
      const { agentResult, errorText } = toStartError(input.sessionId, err);
      if (sessionManager.get(input.sessionId)) {
        sessionManager.setResult(input.sessionId, {
          type: "error",
          result: agentResult,
          createdAt: new Date().toISOString(),
        });
        sessionManager.pushEvent(input.sessionId, {
          type: "error",
          data: agentResult,
          timestamp: new Date().toISOString(),
        });
        sessionManager.update(input.sessionId, {
          status: "error",
          abortController: undefined,
          queryInterrupt: undefined,
        });
      }
      return {
        sessionId: input.sessionId,
        status: "error",
        error: errorText,
      };
    }
  }

  if (existing.status === "running" || existing.status === "waiting_permission") {
    return {
      sessionId: input.sessionId,
      status: "error",
      error: `Error [${ErrorCode.SESSION_BUSY}]: Session is not available (status: ${existing.status}).`,
    };
  }

  if (existing.status === "cancelled") {
    return {
      sessionId: input.sessionId,
      status: "error",
      error: `Error [${ErrorCode.CANCELLED}]: Session '${input.sessionId}' has been cancelled and cannot be resumed.`,
    };
  }

  let normalizedCwd: string;
  let explicitClaudeExecutable: string | undefined;
  try {
    normalizedCwd = normalizeAndAssertWorkingDirectory(existing.cwd, "session cwd", "resolve");
    explicitClaudeExecutable =
      existing.pathToClaudeCodeExecutable !== undefined
        ? resolveExplicitClaudeExecutable(existing.pathToClaudeCodeExecutable, normalizedCwd)
        : undefined;
  } catch (err: unknown) {
    return {
      sessionId: input.sessionId,
      status: "error",
      error: toToolErrorText(err),
    };
  }

  const originalStatus = existing.status;
  const abortController = new AbortController();
  const acquired = sessionManager.tryAcquire(input.sessionId, originalStatus, abortController);
  if (!acquired) {
    const current = sessionManager.get(input.sessionId);
    return {
      sessionId: input.sessionId,
      status: "error",
      error: current
        ? `Error [${ErrorCode.SESSION_BUSY}]: Session is not available (status: ${current.status}).`
        : `Error [${ErrorCode.SESSION_NOT_FOUND}]: Session '${input.sessionId}' not found or expired.`,
    };
  }

  const session = acquired;
  const options = buildOptions({
    ...session,
    cwd: normalizedCwd,
    pathToClaudeCodeExecutable: explicitClaudeExecutable,
  });
  if (input.forkSession) options.forkSession = true;

  if (input.forkSession && !sessionManager.hasCapacityFor(1)) {
    sessionManager.update(input.sessionId, { status: originalStatus, abortController: undefined });
    return {
      sessionId: input.sessionId,
      status: "error",
      error: `Error [${ErrorCode.RESOURCE_EXHAUSTED}]: Too many sessions (limit: ${sessionManager.getMaxSessions()}).`,
    };
  }

  const sourceOverrides: Pick<OptionSource, "effort" | "thinking" | "pathToClaudeCodeExecutable"> =
    {
      effort: input.effort ?? session.effort,
      thinking: input.thinking ?? session.thinking,
      pathToClaudeCodeExecutable: explicitClaudeExecutable,
    };
  if (input.effort !== undefined) options.effort = input.effort;
  if (input.thinking !== undefined) options.thinking = input.thinking;
  if (!input.forkSession && (input.effort !== undefined || input.thinking !== undefined)) {
    const patch: Partial<Pick<OptionSource, "effort" | "thinking">> = {};
    if (input.effort !== undefined) patch.effort = input.effort;
    if (input.thinking !== undefined) patch.thinking = input.thinking;
    sessionManager.update(input.sessionId, patch);
  }

  try {
    const handle = consumeQuery({
      mode: "resume",
      sessionId: input.sessionId,
      prompt: input.prompt,
      abortController,
      options,
      permissionRequestTimeoutMs,
      sessionInitTimeoutMs,
      waitForInitSessionId: !!input.forkSession,
      sessionManager,
      toolCache,
      onInit: (init) => {
        if (!input.forkSession) return;
        if (init.session_id === input.sessionId) {
          throw new Error("Fork requested but no new session ID received from agent.");
        }

        // Restore original session state as soon as we have the fork's session ID.
        // Forking should not affect the original session (including its AbortController).
        sessionManager.update(input.sessionId, {
          status: originalStatus,
          abortController: undefined,
          queryInterrupt: undefined,
        });

        if (!sessionManager.get(init.session_id)) {
          sessionManager.create(
            toSessionCreateParams({
              sessionId: init.session_id,
              source: { ...session, ...sourceOverrides },
              permissionMode: "default",
              abortController,
              queryInterrupt: () => {
                handle.interrupt();
              },
            })
          );
        }
      },
    });
    if (!input.forkSession) {
      sessionManager.update(input.sessionId, {
        queryInterrupt: () => {
          handle.interrupt();
        },
      });
    }

    const sessionId = input.forkSession
      ? await raceWithAbort(handle.sdkSessionIdPromise, requestSignal, () =>
          abortController.abort()
        )
      : input.sessionId;

    const resumeSecret = getResumeSecret();
    return {
      sessionId,
      status: "running",
      pollInterval: DEFAULT_POLL_INTERVAL_RUNNING_MS,
      resumeToken: resumeSecret ? computeResumeToken(sessionId, resumeSecret) : undefined,
    };
  } catch (err: unknown) {
    const { agentResult, errorText } = toStartError(input.sessionId, err);
    if (input.forkSession) {
      sessionManager.update(input.sessionId, {
        status: originalStatus,
        abortController: undefined,
        queryInterrupt: undefined,
      });
    } else {
      sessionManager.setResult(input.sessionId, {
        type: "error",
        result: agentResult,
        createdAt: new Date().toISOString(),
      });
      sessionManager.pushEvent(input.sessionId, {
        type: "error",
        data: agentResult,
        timestamp: new Date().toISOString(),
      });
      sessionManager.update(input.sessionId, {
        status: "error",
        abortController: undefined,
        queryInterrupt: undefined,
      });
    }
    return {
      sessionId: input.sessionId,
      status: "error",
      error: errorText,
    };
  }
}
