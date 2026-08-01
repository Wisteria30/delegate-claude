import { ErrorCode } from "../types.js";

export function toToolErrorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("Error [") ? message : `Error [${ErrorCode.INTERNAL}]: ${message}`;
}
