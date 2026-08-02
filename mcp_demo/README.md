# mcp_demo

This folder contains small, copy/paste-friendly examples for integrating this MCP server into common clients. The MCP server and client are expected to run on the same machine (stdio transport).

## Claude Desktop / Cursor (JSON config)

```json
{
  "mcpServers": {
    "delegate-claude": {
      "command": "npx",
      "args": ["-y", "@wisteria30/delegate-claude"]
    }
  }
}
```

## Anthropic Claude Code CLI

```bash
claude mcp add --transport stdio delegate-claude -- npx -y @wisteria30/delegate-claude
```

## OpenAI Codex CLI

```bash
codex mcp add delegate-claude -- npx -y @wisteria30/delegate-claude
```

## Choosing the Claude executable

The server uses the Claude Code executable bundled with SDK 0.3.220 by default. To select another executable for one session, pass its filesystem path as `advanced.pathToClaudeCodeExecutable` on `claude_code` or `diskResumeConfig.pathToClaudeCodeExecutable` on disk resume. The server validates the path before starting the SDK query and does not try another executable if validation or launch fails.

## Polling + permissions (v2 async)

`claude_code` / `claude_code_reply` start sessions asynchronously and return `{ sessionId, status: "running", pollInterval }`.

To read progress, fetch the final result, and handle permission requests, call `claude_code_check`:

```json
{ "action": "poll", "sessionId": "<sessionId>" }
```

Store `nextCursor` from the response and pass it back on the next poll to avoid replaying old events:

```json
{ "action": "poll", "sessionId": "<sessionId>", "cursor": 123 }
```

Replace `123` with the `nextCursor` value from the previous response.

By default, `claude_code_check` uses `responseMode="minimal"` (smaller payloads) and paginates with `maxEvents=200`. If you need more detail (usage/modelUsage/structuredOutput), set `responseMode="full"`.

If `status` becomes `waiting_permission`, approve/deny each entry in `actions[]` (requests auto-deny on timeout; see `actions[].expiresAt` / `actions[].remainingMs`):

```json
{
  "action": "respond_permission",
  "sessionId": "<sessionId>",
  "requestId": "<requestId>",
  "decision": "allow"
}
```

## Windows: Git Bash path

If you see the error about missing `git-bash`, set `CLAUDE_CODE_GIT_BASH_PATH`:

```json
{
  "mcpServers": {
    "delegate-claude": {
      "command": "npx",
      "args": ["-y", "@wisteria30/delegate-claude"],
      "env": {
        "CLAUDE_CODE_GIT_BASH_PATH": "C:\\Program Files\\Git\\bin\\bash.exe"
      }
    }
  }
}
```

For a full end-to-end local test plan (permissions/polling/session lifecycle + real coding tasks), see `docs/E2E_LOCAL_TEST_PLAN.md`.
