import { ErrorCode } from "../types.js";

/**
 * Format a tool-executor failure, passing through text that is already classified as `Error [CODE]`.
 *
 * The MCP handler boundary in `src/server.ts` intentionally does not use this: anything that escapes
 * an executor is INTERNAL by definition, so those catch blocks classify unconditionally.
 */
export function toToolErrorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("Error [") ? message : `Error [${ErrorCode.INTERNAL}]: ${message}`;
}
