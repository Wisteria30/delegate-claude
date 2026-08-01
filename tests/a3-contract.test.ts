import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../src/session/manager.js";

vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  class AbortError extends Error {
    constructor(message?: string) {
      super(message ?? "The operation was aborted");
      this.name = "AbortError";
    }
  }
  return { query: vi.fn(), AbortError };
});

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { HookCallback, Options } from "@anthropic-ai/claude-agent-sdk";
import { executeClaudeCode } from "../src/tools/claude-code.js";
import { executeClaudeCodeReply } from "../src/tools/claude-code-reply.js";
import { executeClaudeCodeCheck } from "../src/tools/claude-code-check.js";
import type { CheckResult, PermissionMode } from "../src/types.js";

const mockQuery = vi.mocked(query);
type QueryReturn = ReturnType<typeof query>;
type QueryParams = Parameters<typeof query>[0];

function initMessage(sessionId: string, permissionMode: PermissionMode, model = "claude-test") {
  return {
    type: "system" as const,
    subtype: "init" as const,
    session_id: sessionId,
    uuid: `init-${sessionId}`,
    cwd: "/tmp",
    tools: ["AskUserQuestion", "Read"],
    claude_code_version: "2.1.0",
    model,
    permissionMode,
    apiKeySource: "env" as const,
    mcp_servers: [],
    slash_commands: [],
    output_style: "",
    skills: [],
    plugins: [],
  };
}

function successMessage(sessionId: string) {
  return {
    type: "result" as const,
    subtype: "success" as const,
    result: "done",
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    total_cost_usd: 0,
    is_error: false,
    uuid: `result-${sessionId}`,
    session_id: sessionId,
    stop_reason: null,
    usage: {},
    modelUsage: {},
    permission_denials: [],
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let tick = 0; tick < 100; tick++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not reached");
}

describe("A3 permission and user-question contract", () => {
  const managers: SessionManager[] = [];

  afterEach(() => {
    for (const manager of managers) manager.destroy();
    managers.length = 0;
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("starts with default permission mode and reports effective init metadata", async () => {
    const manager = new SessionManager();
    managers.push(manager);
    mockQuery.mockReturnValue(
      (async function* () {
        yield initMessage("default-session", "default", "claude-effective");
        yield successMessage("default-session");
      })() as unknown as QueryReturn
    );

    const started = await executeClaudeCode({ prompt: "run" }, manager, "/tmp");

    expect(started).toMatchObject({
      status: "running",
      sessionId: "default-session",
      model: "claude-effective",
      claudeCodeVersion: "2.1.0",
      permissionMode: "default",
    });
    const call = mockQuery.mock.calls[0]![0] as QueryParams;
    expect(call.options?.permissionMode).toBe("default");
    await waitUntil(() => manager.get("default-session")?.status === "idle");
    expect(manager.getResult("default-session")?.result).toMatchObject({
      model: "claude-effective",
      claudeCodeVersion: "2.1.0",
      permissionMode: "default",
    });
  });

  it("passes the dangerous bypass pair and rejects every invalid pair before query", async () => {
    const validManager = new SessionManager();
    managers.push(validManager);
    mockQuery.mockReturnValue(
      (async function* () {
        yield initMessage("bypass-session", "bypassPermissions");
        yield successMessage("bypass-session");
      })() as unknown as QueryReturn
    );
    const valid = await executeClaudeCode(
      {
        prompt: "run",
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
      },
      validManager,
      "/tmp"
    );
    expect(valid.status).toBe("running");
    const options = (mockQuery.mock.calls[0]![0] as QueryParams).options;
    expect(options).toMatchObject({
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    });

    mockQuery.mockClear();
    const invalidManager = new SessionManager();
    managers.push(invalidManager);
    const missingFlag = await executeClaudeCode(
      { prompt: "run", permissionMode: "bypassPermissions" },
      invalidManager,
      "/tmp"
    );
    const wrongMode = await executeClaudeCode(
      {
        prompt: "run",
        permissionMode: "plan",
        allowDangerouslySkipPermissions: true,
      },
      invalidManager,
      "/tmp"
    );
    expect(missingFlag.status === "error" ? missingFlag.error.code : undefined).toBe(
      "INVALID_ARGUMENT"
    );
    expect(wrongMode.status === "error" ? wrongMode.error.code : undefined).toBe(
      "INVALID_ARGUMENT"
    );
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("returns MODEL_UNAVAILABLE for an unavailable explicit model without retrying another model", async () => {
    const manager = new SessionManager();
    managers.push(manager);
    mockQuery.mockReturnValue(
      (async function* () {
        throw new Error("model claude-missing is not available");
        yield undefined as never;
      })() as unknown as QueryReturn
    );

    const result = await executeClaudeCode(
      { prompt: "run", model: "claude-missing" },
      manager,
      "/tmp"
    );

    expect(result.status === "error" ? result.error : undefined).toEqual({
      code: "MODEL_UNAVAILABLE",
      message: "Requested model 'claude-missing' is unavailable.",
      recoverable: true,
    });
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect((mockQuery.mock.calls[0]![0] as QueryParams).options?.model).toBe("claude-missing");
  });

  it.each([
    ["default", undefined],
    ["bypassPermissions", true],
  ] as const)(
    "keeps AskUserQuestion pending in %s mode and resumes the same session",
    async (permissionMode, dangerousFlag) => {
      const manager = new SessionManager();
      managers.push(manager);
      let hookResult: Awaited<ReturnType<HookCallback>> | undefined;
      mockQuery.mockImplementation((params) => {
        const queryParams = params as QueryParams;
        return (async function* () {
          yield initMessage("question-session", permissionMode);
          const hook = queryParams.options?.hooks?.PreToolUse?.[0]?.hooks[0];
          expect(queryParams.options?.canUseTool).toBeTypeOf("function");
          expect(hook).toBeTypeOf("function");
          hookResult = await hook!(
            {
              hook_event_name: "PreToolUse",
              session_id: "question-session",
              cwd: "/tmp",
              transcript_path: "/tmp/transcript",
              permission_mode: permissionMode,
              tool_name: "AskUserQuestion",
              tool_input: {
                questions: [
                  {
                    question: "Which option?",
                    header: "Choice",
                    options: [
                      { label: "A", description: "First", preview: "preview-a" },
                      { label: "B", description: "Second" },
                    ],
                    multiSelect: true,
                  },
                ],
              },
              tool_use_id: "question-tool-use",
            },
            "question-tool-use",
            { signal: queryParams.options!.abortController!.signal }
          );
          yield successMessage("question-session");
        })() as unknown as QueryReturn;
      });

      const started = await executeClaudeCode(
        {
          prompt: "ask",
          permissionMode,
          allowDangerouslySkipPermissions: dangerousFlag,
        },
        manager,
        "/tmp"
      );
      expect(started.status).toBe("running");
      await waitUntil(() => manager.get("question-session")?.status === "waiting_user_input");

      const poll = executeClaudeCodeCheck(
        { action: "poll", sessionId: "question-session" },
        manager
      ) as CheckResult;
      expect(poll.actions).toHaveLength(1);
      expect(poll.actions?.[0]).toMatchObject({
        type: "user_question",
        toolUseId: "question-tool-use",
        questions: [
          {
            question: "Which option?",
            header: "Choice",
            options: [
              { label: "A", description: "First", preview: "preview-a" },
              { label: "B", description: "Second" },
            ],
            multiSelect: true,
          },
        ],
      });
      expect(poll.actions?.[0]?.toolName).toBeUndefined();

      const requestId = poll.actions![0]!.requestId;
      const response = executeClaudeCodeCheck(
        {
          action: "respond_user_input",
          sessionId: "question-session",
          requestId,
          answers: { "Which option?": "A,B" },
          response: "selected",
          annotations: { "Which option?": { preview: "preview-a", notes: "note" } },
        },
        manager
      );
      expect("isError" in response).toBe(false);
      await waitUntil(() => manager.get("question-session")?.status === "idle");
      expect(hookResult).toMatchObject({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          updatedInput: {
            answers: { "Which option?": "A,B" },
            response: "selected",
            annotations: { "Which option?": { preview: "preview-a", notes: "note" } },
          },
        },
      });
      const questionResultEvent = manager
        .readEvents("question-session")
        .events.find((event) => event.type === "user_question_result");
      expect(JSON.stringify(questionResultEvent)).not.toContain("A,B");

      const duplicate = executeClaudeCodeCheck(
        {
          action: "respond_user_input",
          sessionId: "question-session",
          requestId,
          answers: { "Which option?": "A" },
        },
        manager
      );
      expect("error" in duplicate ? duplicate.error.code : undefined).toBe(
        "USER_INPUT_REQUEST_NOT_FOUND"
      );
    }
  );

  it("fails closed when a user-question request is answered through another session", () => {
    const manager = new SessionManager();
    managers.push(manager);
    manager.create({ sessionId: "owner", cwd: "/tmp" });
    manager.create({ sessionId: "other", cwd: "/tmp" });
    manager.setPendingUserQuestion(
      "owner",
      {
        requestId: "question-request",
        toolUseId: "tool-use",
        questions: [{ question: "Q?", header: "Q", options: [], multiSelect: false }],
        originalInput: { questions: [] },
        createdAt: new Date().toISOString(),
        expiresAt: "",
      },
      vi.fn()
    );

    const result = executeClaudeCodeCheck(
      {
        action: "respond_user_input",
        sessionId: "other",
        requestId: "question-request",
        answers: { "Q?": "A" },
      },
      manager
    );
    expect("error" in result ? result.error.code : undefined).toBe("USER_INPUT_SESSION_MISMATCH");
    expect(manager.getPendingUserQuestionCount("owner")).toBe(1);
  });

  it("releases a timed-out question once and records USER_INPUT_TIMEOUT", async () => {
    vi.useFakeTimers();
    const manager = new SessionManager();
    managers.push(manager);
    const abortController = new AbortController();
    const finish = vi.fn();
    manager.create({ sessionId: "timeout", cwd: "/tmp", abortController });
    manager.setPendingUserQuestion(
      "timeout",
      {
        requestId: "timeout-request",
        toolUseId: "tool-use",
        questions: [{ question: "Q?", header: "Q", options: [], multiSelect: false }],
        originalInput: { questions: [] },
        createdAt: new Date().toISOString(),
        expiresAt: "",
      },
      finish,
      30 * 60 * 1000
    );

    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);

    expect(finish).toHaveBeenCalledTimes(1);
    expect(manager.getTerminalError("timeout")?.code).toBe("USER_INPUT_TIMEOUT");
    expect(abortController.signal.aborted).toBe(true);
    manager.destroy();
    expect(finish).toHaveBeenCalledTimes(1);
  });

  it("records USER_INPUT_TIMEOUT in the terminal AgentResult", async () => {
    vi.useFakeTimers();
    const manager = new SessionManager();
    managers.push(manager);
    mockQuery.mockImplementation((params) => {
      const queryParams = params as QueryParams;
      return (async function* () {
        yield initMessage("timeout-result", "default");
        const hook = queryParams.options?.hooks?.PreToolUse?.[0]?.hooks[0];
        await hook!(
          {
            hook_event_name: "PreToolUse",
            session_id: "timeout-result",
            cwd: "/tmp",
            transcript_path: "/tmp/transcript",
            permission_mode: "default",
            tool_name: "AskUserQuestion",
            tool_input: {
              questions: [
                { question: "Continue?", header: "Continue", options: [], multiSelect: false },
              ],
            },
            tool_use_id: "timeout-tool",
          },
          "timeout-tool",
          { signal: queryParams.options!.abortController!.signal }
        );
        throw new Error("The operation was aborted");
      })() as unknown as QueryReturn;
    });

    const startedPromise = executeClaudeCode({ prompt: "ask" }, manager, "/tmp");
    await vi.advanceTimersByTimeAsync(0);
    const started = await startedPromise;
    expect(started.status).toBe("running");
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(manager.get("timeout-result")?.status).toBe("error");
    expect(manager.getResult("timeout-result")?.result.error).toEqual({
      code: "USER_INPUT_TIMEOUT",
      message: "User input was not provided within 1800000ms.",
      recoverable: true,
    });
  });

  it.each(["cancel", "interrupt", "destroy"] as const)(
    "releases a pending question exactly once on %s",
    (operation) => {
      const manager = new SessionManager();
      managers.push(manager);
      const finish = vi.fn();
      manager.create({
        sessionId: `lifecycle-${operation}`,
        cwd: "/tmp",
        abortController: new AbortController(),
      });
      manager.setPendingUserQuestion(
        `lifecycle-${operation}`,
        {
          requestId: `request-${operation}`,
          toolUseId: "tool-use",
          questions: [{ question: "Q?", header: "Q", options: [], multiSelect: false }],
          originalInput: { questions: [] },
          createdAt: new Date().toISOString(),
          expiresAt: "",
        },
        finish
      );

      if (operation === "cancel") manager.cancel(`lifecycle-${operation}`);
      else if (operation === "interrupt") manager.interrupt(`lifecycle-${operation}`);
      else manager.destroy();
      manager.destroy();

      expect(finish).toHaveBeenCalledTimes(1);
    }
  );

  it("inherits reply permission mode and applies explicit mode, effort, and thinking changes", async () => {
    const manager = new SessionManager();
    managers.push(manager);
    manager.create({
      sessionId: "reply-session",
      cwd: "/tmp",
      permissionMode: "plan",
      effort: "low",
      thinking: { type: "disabled" },
    });
    manager.update("reply-session", { status: "idle" });
    mockQuery.mockReturnValue(
      (async function* () {
        yield successMessage("reply-session");
      })() as unknown as QueryReturn
    );

    const inherited = await executeClaudeCodeReply(
      { sessionId: "reply-session", prompt: "continue" },
      manager
    );
    expect(inherited.status).toBe("running");
    let options = (mockQuery.mock.calls[0]![0] as QueryParams).options as Partial<Options>;
    expect(options.resume).toBe("reply-session");
    expect(options.permissionMode).toBe("plan");
    await waitUntil(() => manager.get("reply-session")?.status === "idle");

    mockQuery.mockClear();
    mockQuery.mockReturnValue(
      (async function* () {
        yield successMessage("reply-session");
      })() as unknown as QueryReturn
    );
    const changed = await executeClaudeCodeReply(
      {
        sessionId: "reply-session",
        prompt: "continue again",
        permissionMode: "acceptEdits",
        effort: "xhigh",
        thinking: { type: "adaptive", display: "omitted" },
      },
      manager
    );
    expect(changed.status).toBe("running");
    options = (mockQuery.mock.calls[0]![0] as QueryParams).options as Partial<Options>;
    expect(options).toMatchObject({
      resume: "reply-session",
      permissionMode: "acceptEdits",
      effort: "xhigh",
      thinking: { type: "adaptive", display: "omitted" },
    });
    expect(manager.get("reply-session")).toMatchObject({
      permissionMode: "acceptEdits",
      effort: "xhigh",
      thinking: { type: "adaptive", display: "omitted" },
    });
  });

  it("rejects an invalid explicit reply permission pair before query", async () => {
    const manager = new SessionManager();
    managers.push(manager);
    manager.create({ sessionId: "invalid-reply", cwd: "/tmp", permissionMode: "default" });
    manager.update("invalid-reply", { status: "idle" });

    const result = await executeClaudeCodeReply(
      {
        sessionId: "invalid-reply",
        prompt: "continue",
        permissionMode: "bypassPermissions",
      },
      manager
    );

    expect(result.status === "error" ? result.error.code : undefined).toBe("INVALID_ARGUMENT");
    expect(manager.get("invalid-reply")?.status).toBe("idle");
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
