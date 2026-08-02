/**
 * The error half of what the two start-path tools (`claude_code`, `claude_code_reply`)
 * return. Both answer with the same envelope, so the shape and its factory live here
 * rather than being restated in each tool — mirroring `checkError` / `sessionError`.
 */
import type { ErrorCode, StructuredError } from "../types.js";
import { structuredError } from "../utils/structured-error.js";

export interface StartErrorResult {
  sessionId: string;
  status: "error";
  error: StructuredError;
}

export function startError(sessionId: string, code: ErrorCode, message: string): StartErrorResult {
  return { sessionId, status: "error", error: structuredError(code, message) };
}

/** For a `StructuredError` that has already been classified (e.g. by `classifySdkStartError`). */
export function startErrorFrom(sessionId: string, error: StructuredError): StartErrorResult {
  return { sessionId, status: "error", error };
}
