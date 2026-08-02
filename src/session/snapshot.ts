import type { PublicSessionInfo, SensitiveSessionInfo, SessionInfo } from "../types.js";
import type { SessionManager } from "./manager.js";
import { buildSessionRedactions } from "./redactions.js";

export function buildSessionSnapshot(input: {
  sessionManager: SessionManager;
  session: SessionInfo;
  includeSensitive: boolean | undefined;
}): PublicSessionInfo | SensitiveSessionInfo {
  const { sessionManager, session, includeSensitive } = input;
  const base =
    includeSensitive === true
      ? sessionManager.toSensitiveJSON(session)
      : sessionManager.toPublicJSON(session);
  const stored = sessionManager.getResult(session.sessionId);
  const lastError = stored?.type === "error" ? stored.result.result : undefined;
  const lastErrorAt = stored?.type === "error" ? stored.createdAt : undefined;
  return {
    ...base,
    pendingPermissionCount: sessionManager.getPendingPermissionCount(session.sessionId),
    pendingUserQuestionCount: sessionManager.getPendingUserQuestionCount(session.sessionId),
    eventCount: sessionManager.getEventCount(session.sessionId),
    currentCursor: sessionManager.getCurrentCursor(session.sessionId),
    lastEventId: sessionManager.getLastEventId(session.sessionId),
    ttlMs: sessionManager.getRemainingTtlMs(session.sessionId),
    lastError,
    lastErrorAt,
    redactions: buildSessionRedactions(includeSensitive),
  };
}
