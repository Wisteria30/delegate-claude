/**
 * Shared helper to build SDK query options from a flat source object.
 *
 * All three call-sites (claude-code start, reply from session, disk-resume)
 * share the same field-by-field copy logic.  This function centralises it so
 * a newly-added Options field only needs to be wired once.
 */
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentDefinition,
  EffortLevel,
  Settings,
  McpServerConfig,
  OutputFormat,
  PermissionMode,
  SandboxSettings,
  SettingSource,
  SystemPrompt,
  ThinkingConfig,
  ToolConfig,
  ToolsConfig,
} from "../types.js";
import { DEFAULT_SETTING_SOURCES } from "../types.js";
import { normalizeWindowsPathArray, normalizeWindowsPathLike } from "./normalize-windows-path.js";

/** Superset of fields that any of the three call-sites may provide. */
export interface OptionSource {
  cwd: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  tools?: ToolsConfig;
  maxTurns?: number;
  model?: string;
  permissionMode?: PermissionMode;
  allowDangerouslySkipPermissions?: boolean;
  systemPrompt?: SystemPrompt;
  agents?: Record<string, AgentDefinition>;
  maxBudgetUsd?: number;
  effort?: EffortLevel;
  betas?: string[];
  additionalDirectories?: string[];
  outputFormat?: OutputFormat;
  thinking?: ThinkingConfig;
  persistSession?: boolean;
  resumeSessionAt?: string;
  pathToClaudeCodeExecutable?: string;
  agent?: string;
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

/**
 * Normalize the path-bearing `OptionSource` fields that are also persisted on the session record.
 *
 * `buildOptions` normalizes these again on the way to the SDK; this exists so the stored session
 * snapshot carries the same values the SDK was handed. `pathToClaudeCodeExecutable` is deliberately
 * not included: it needs validation, which each call site performs at its own point in the
 * validation order.
 */
export function normalizeOptionSourcePaths(
  src: Pick<OptionSource, "additionalDirectories" | "debugFile">
): Pick<OptionSource, "additionalDirectories" | "debugFile"> {
  return {
    additionalDirectories:
      src.additionalDirectories !== undefined
        ? normalizeWindowsPathArray(src.additionalDirectories)
        : undefined,
    debugFile: src.debugFile !== undefined ? normalizeWindowsPathLike(src.debugFile) : undefined,
  };
}

/**
 * Build SDK `Partial<Options>` from a flat source object.
 *
 * Only copies fields that are explicitly defined (not `undefined`) so that
 * SDK defaults are preserved for omitted fields.
 */
export function buildOptions(src: OptionSource): Partial<Options> {
  const opts: Partial<Options> = { cwd: normalizeWindowsPathLike(src.cwd) };

  if (src.allowedTools !== undefined) opts.allowedTools = src.allowedTools;
  if (src.disallowedTools !== undefined) opts.disallowedTools = src.disallowedTools;
  if (src.tools !== undefined) opts.tools = src.tools;
  if (src.maxTurns !== undefined) opts.maxTurns = src.maxTurns;
  if (src.model !== undefined) opts.model = src.model;
  if (src.permissionMode !== undefined) opts.permissionMode = src.permissionMode;
  if (src.allowDangerouslySkipPermissions !== undefined)
    opts.allowDangerouslySkipPermissions = src.allowDangerouslySkipPermissions;
  if (src.systemPrompt !== undefined) opts.systemPrompt = src.systemPrompt;
  if (src.agents !== undefined) opts.agents = src.agents as Options["agents"];
  if (src.maxBudgetUsd !== undefined) opts.maxBudgetUsd = src.maxBudgetUsd;
  if (src.effort !== undefined) opts.effort = src.effort;
  if (src.betas !== undefined) opts.betas = src.betas as Options["betas"];
  if (src.additionalDirectories !== undefined)
    opts.additionalDirectories = normalizeWindowsPathArray(src.additionalDirectories);
  if (src.outputFormat !== undefined) opts.outputFormat = src.outputFormat;
  if (src.thinking !== undefined) opts.thinking = src.thinking;
  if (src.persistSession !== undefined) opts.persistSession = src.persistSession;
  if (src.resumeSessionAt !== undefined) opts.resumeSessionAt = src.resumeSessionAt;
  if (src.pathToClaudeCodeExecutable !== undefined)
    opts.pathToClaudeCodeExecutable = normalizeWindowsPathLike(src.pathToClaudeCodeExecutable);
  if (src.agent !== undefined) opts.agent = src.agent;
  if (src.mcpServers !== undefined) opts.mcpServers = src.mcpServers as Options["mcpServers"];
  if (src.sandbox !== undefined) opts.sandbox = src.sandbox;
  if (src.enableFileCheckpointing !== undefined)
    opts.enableFileCheckpointing = src.enableFileCheckpointing;
  if (src.toolConfig !== undefined) opts.toolConfig = src.toolConfig;
  if (src.includePartialMessages !== undefined)
    opts.includePartialMessages = src.includePartialMessages;
  if (src.promptSuggestions !== undefined) opts.promptSuggestions = src.promptSuggestions;
  if (src.agentProgressSummaries !== undefined)
    opts.agentProgressSummaries = src.agentProgressSummaries;
  if (src.strictMcpConfig !== undefined) opts.strictMcpConfig = src.strictMcpConfig;
  if (src.settings !== undefined) opts.settings = src.settings;
  if (src.settingSources !== undefined) opts.settingSources = src.settingSources;
  else opts.settingSources = DEFAULT_SETTING_SOURCES;
  if (src.debug !== undefined) opts.debug = src.debug;
  if (src.debugFile !== undefined) opts.debugFile = normalizeWindowsPathLike(src.debugFile);
  if (src.env !== undefined) opts.env = { ...process.env, ...src.env };

  return opts;
}
