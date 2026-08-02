/**
 * claude_code_session tool - Manage sessions (list, get, cancel, interrupt)
 */
import type { SessionManager } from "../session/manager.js";
import { buildSessionSnapshot } from "../session/snapshot.js";
import type {
  PublicSessionInfo,
  SensitiveSessionInfo,
  SessionInfo,
  SessionAction,
  StructuredError,
} from "../types.js";
import { ErrorCode } from "../types.js";
import { structuredError } from "../utils/structured-error.js";

export interface ClaudeCodeSessionInput {
  action: SessionAction;
  sessionId?: string;
  includeSensitive?: boolean;
}

export interface SessionResult {
  sessions: Array<PublicSessionInfo | SensitiveSessionInfo>;
  message?: string;
  error?: StructuredError;
  isError?: boolean;
}

function sessionError(
  code: ErrorCode,
  message: string,
  sessions: SessionResult["sessions"] = []
): SessionResult {
  return { sessions, error: structuredError(code, message), isError: true };
}
export function executeClaudeCodeSession(
  input: ClaudeCodeSessionInput,
  sessionManager: SessionManager,
  requestSignal?: AbortSignal
): SessionResult {
  if (requestSignal?.aborted) {
    return sessionError(ErrorCode.CANCELLED, "Request was cancelled.");
  }

  const toSessionJson = (session: SessionInfo): PublicSessionInfo | SensitiveSessionInfo =>
    buildSessionSnapshot({
      sessionManager,
      session,
      includeSensitive: input.includeSensitive,
    });

  switch (input.action) {
    case "list": {
      const sessions = sessionManager.list().map((s) => toSessionJson(s));
      return { sessions };
    }

    case "get": {
      if (!input.sessionId) {
        return sessionError(ErrorCode.INVALID_ARGUMENT, "sessionId is required for 'get' action.");
      }
      const session = sessionManager.get(input.sessionId);
      if (!session) {
        return sessionError(ErrorCode.SESSION_NOT_FOUND, `Session '${input.sessionId}' not found.`);
      }
      return { sessions: [toSessionJson(session)] };
    }

    case "cancel": {
      if (!input.sessionId) {
        return sessionError(
          ErrorCode.INVALID_ARGUMENT,
          "sessionId is required for 'cancel' action."
        );
      }
      const cancelled = sessionManager.cancel(input.sessionId, {
        reason: "Cancelled by caller",
        source: "claude_code_session",
      });
      if (!cancelled) {
        const session = sessionManager.get(input.sessionId);
        if (!session) {
          return sessionError(
            ErrorCode.SESSION_NOT_FOUND,
            `Session '${input.sessionId}' not found.`
          );
        }
        return sessionError(
          ErrorCode.INVALID_ARGUMENT,
          `Session '${input.sessionId}' is not running (status: ${session.status}).`,
          [toSessionJson(session)]
        );
      }
      const updated = sessionManager.get(input.sessionId);
      return {
        sessions: updated ? [toSessionJson(updated)] : [],
        message: `Session '${input.sessionId}' cancelled.`,
      };
    }

    case "interrupt": {
      if (!input.sessionId) {
        return sessionError(
          ErrorCode.INVALID_ARGUMENT,
          "sessionId is required for 'interrupt' action."
        );
      }
      const interrupted = sessionManager.interrupt(input.sessionId, {
        reason: "Interrupted by caller",
        source: "claude_code_session",
      });
      if (!interrupted) {
        const session = sessionManager.get(input.sessionId);
        if (!session) {
          return sessionError(
            ErrorCode.SESSION_NOT_FOUND,
            `Session '${input.sessionId}' not found.`
          );
        }
        return sessionError(
          ErrorCode.INVALID_ARGUMENT,
          `Session '${input.sessionId}' is not running (status: ${session.status}).`,
          [toSessionJson(session)]
        );
      }
      const updated = sessionManager.get(input.sessionId);
      return {
        sessions: updated ? [toSessionJson(updated)] : [],
        message: `Session '${input.sessionId}' interrupted.`,
      };
    }

    default:
      return sessionError(
        ErrorCode.INVALID_ARGUMENT,
        `Unknown action '${input.action}'. Use 'list', 'get', 'cancel', or 'interrupt'.`
      );
  }
}
