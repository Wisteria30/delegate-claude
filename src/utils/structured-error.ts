import { ErrorCode } from "../types.js";
import type { StructuredError } from "../types.js";

const RECOVERABLE_CODES = new Set<ErrorCode>([
  ErrorCode.INVALID_ARGUMENT,
  ErrorCode.SESSION_NOT_FOUND,
  ErrorCode.SESSION_BUSY,
  ErrorCode.PERMISSION_REQUEST_NOT_FOUND,
  ErrorCode.USER_INPUT_REQUEST_NOT_FOUND,
  ErrorCode.USER_INPUT_SESSION_MISMATCH,
  ErrorCode.MODEL_UNAVAILABLE,
  ErrorCode.USER_INPUT_TIMEOUT,
  ErrorCode.PERMISSION_TIMEOUT,
  ErrorCode.RESOURCE_EXHAUSTED,
  ErrorCode.TIMEOUT,
  ErrorCode.CANCELLED,
]);

const ERROR_CODES = new Set<string>(Object.values(ErrorCode));

export class DelegateError extends Error {
  readonly detail: StructuredError;

  constructor(detail: StructuredError) {
    super(detail.message);
    this.name = "DelegateError";
    this.detail = detail;
  }
}

export function isRecoverable(code: ErrorCode): boolean {
  return RECOVERABLE_CODES.has(code);
}

export function structuredError(code: ErrorCode, message: string): StructuredError {
  return { code, message, recoverable: isRecoverable(code) };
}

export function formatStructuredError(error: StructuredError): string {
  return `Error [${error.code}]: ${error.message}`;
}

export function toStructuredError(err: unknown, fallbackCode: ErrorCode): StructuredError {
  if (err instanceof DelegateError) return err.detail;
  const message = err instanceof Error ? err.message : String(err);
  const match = /^Error \[([A-Z_]+)\]:\s*(.*)$/s.exec(message);
  if (match && ERROR_CODES.has(match[1])) {
    return structuredError(match[1] as ErrorCode, match[2] ?? "Unknown error");
  }
  return structuredError(fallbackCode, message);
}

export function classifySdkStartError(err: unknown, explicitModel?: string): StructuredError {
  const message = err instanceof Error ? err.message : String(err);
  if (explicitModel) {
    const lower = message.toLowerCase();
    if (
      (lower.includes("model") || lower.includes(explicitModel.toLowerCase())) &&
      (lower.includes("not available") ||
        lower.includes("unavailable") ||
        lower.includes("not found") ||
        lower.includes("not allowed") ||
        lower.includes("unsupported"))
    ) {
      return structuredError(
        ErrorCode.MODEL_UNAVAILABLE,
        `Requested model '${explicitModel}' is unavailable.`
      );
    }
  }
  const known = toStructuredError(err, ErrorCode.SDK_START_FAILED);
  return known.code === ErrorCode.SDK_START_FAILED
    ? structuredError(ErrorCode.SDK_START_FAILED, "Claude Agent SDK failed to start.")
    : known;
}
