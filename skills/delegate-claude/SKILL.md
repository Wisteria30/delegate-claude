---
name: delegate-claude
description: Delegate consultation, design, review, implementation, and testing to Claude Code through the delegate-claude MCP server while preserving one session across follow-ups and explicitly relaying permissions and user questions.
---

# Delegate Claude

Use the four `delegate-claude` MCP tools. Do not invoke Claude Code through a second path when this skill is active, and do not switch models when the requested model is unavailable.

## Choose the permission mode

- Consultation, investigation, design, or review: `default`.
- Implementation, fixes, or tests: `acceptEdits`.
- Planning without execution: `plan`.
- `bypassPermissions`: only when the user explicitly authorizes permission bypass for the delegated scope. Send `allowDangerouslySkipPermissions: true` in the same request.

Keep `allowedTools` and `disallowedTools` narrow when the request defines a tool boundary. Never approve a tool listed in `disallowedTools`.

## Start and monitor

1. Call `claude_code` with the task, repository `cwd`, chosen permission mode, and the user's model when specified.
2. Persist `sessionId` and the latest `nextCursor` locally in the current reasoning context.
3. Poll `claude_code_check` with `action: "poll"` and the saved cursor. Respect the returned `pollInterval`; longer coding work normally needs longer waits.
4. Stop polling only when the session is `idle`, `error`, or `cancelled`, or when an action needs a response.
5. For the same objective, codebase, and decision chain, continue with `claude_code_reply` and the existing `sessionId`. Start a new session only for independent work or an independent review.

## Relay actions

For a `permission` action, compare the requested tool and input with the user's authorized scope. Respond through `claude_code_check` with `action: "respond_permission"`. Deny operations outside that scope; use `allow_for_session` only when repeated use of the same operation is already authorized.

For a `user_question` action:

1. Present Claude's question, options, descriptions, order, and multi-select setting to the user without rewriting their meaning.
2. Wait for the user's answer; never infer or automatically select an answer, including in `bypassPermissions` mode.
3. Call `claude_code_check` with `action: "respond_user_input"`, the same `sessionId` and `requestId`, and an `answers` map keyed by the original question text. Encode multiple selections as one comma-separated string.
4. Continue polling the same session.

Use the optional `response` and `annotations` fields only when the user or calling workflow supplies those values. They augment the original `AskUserQuestion` input; they are not an alternative answer channel.

## Finish

Verify the final MCP result, effective model, Claude Code version, permission mode, and actual repository diff. For implementation work, confirm Claude ran the relevant local checks and independently inspect the changed files before reporting completion. Treat structured errors as failures; do not retry through another model, executable, session, or unapproved recovery path.
