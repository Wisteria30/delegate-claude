import type { PublicSessionInfo } from "../types.js";

const ALWAYS_REDACTED_FIELDS = [
  "env",
  "mcpServers",
  "sandbox",
  "settings",
  "debugFile",
  "pathToClaudeCodeExecutable",
] as const;

const CONDITIONAL_REDACTED_FIELDS = [
  "cwd",
  "systemPrompt",
  "agents",
  "additionalDirectories",
  "toolConfig",
] as const;

export function buildSessionRedactions(
  includeSensitive?: boolean
): PublicSessionInfo["redactions"] {
  const redactions: PublicSessionInfo["redactions"] = [];
  for (const field of ALWAYS_REDACTED_FIELDS) {
    redactions?.push({ field, reason: "secret_or_internal" });
  }
  if (!includeSensitive) {
    for (const field of CONDITIONAL_REDACTED_FIELDS) {
      redactions?.push({ field, reason: "sensitive_by_default" });
    }
  }
  return redactions;
}
