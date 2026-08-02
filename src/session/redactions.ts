import type { PublicSessionInfo } from "../types.js";

const ALWAYS_REDACTED_FIELDS = [
  "env",
  "mcpServers",
  "sandbox",
  "settings",
  "debugFile",
  "pathToClaudeCodeExecutable",
  "allowDangerouslySkipPermissions",
] as const;

const CONDITIONAL_REDACTED_FIELDS = [
  "cwd",
  "systemPrompt",
  "agents",
  "additionalDirectories",
  "toolConfig",
] as const;

type Redactions = NonNullable<PublicSessionInfo["redactions"]>;

/** Both variants are constant for the process lifetime and are only ever serialized. */
const SENSITIVE_INCLUDED_REDACTIONS: Redactions = ALWAYS_REDACTED_FIELDS.map((field) => ({
  field,
  reason: "secret_or_internal",
}));

const DEFAULT_REDACTIONS: Redactions = [
  ...SENSITIVE_INCLUDED_REDACTIONS,
  ...CONDITIONAL_REDACTED_FIELDS.map((field) => ({
    field,
    reason: "sensitive_by_default" as const,
  })),
];

export function buildSessionRedactions(
  includeSensitive?: boolean
): PublicSessionInfo["redactions"] {
  return includeSensitive ? SENSITIVE_INCLUDED_REDACTIONS : DEFAULT_REDACTIONS;
}
