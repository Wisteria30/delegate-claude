import { ErrorCode } from "../types.js";
import type { StructuredError } from "../types.js";
import { toStructuredError } from "./structured-error.js";

export function toToolError(err: unknown, fallbackCode = ErrorCode.INTERNAL): StructuredError {
  return toStructuredError(err, fallbackCode);
}
