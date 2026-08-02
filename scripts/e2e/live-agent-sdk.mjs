import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MODEL = "claude-opus-5";
const QUESTION_TIMEOUT_MS = 180_000;
const RESULT_TIMEOUT_MS = 300_000;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function payload(result) {
  if (result?.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }
  const text = result?.content?.find((item) => item.type === "text")?.text;
  assert(typeof text === "string", "MCP response did not contain JSON text");
  return JSON.parse(text);
}

function transportConfig() {
  return {
    command: process.execPath,
    args: [path.join(process.cwd(), "dist", "index.js")],
    cwd: process.cwd(),
    stderr: "pipe",
    env: process.env,
  };
}

async function connectClient(label) {
  const transport = new StdioClientTransport(transportConfig());
  if (transport.stderr) {
    transport.stderr.on("data", (chunk) => process.stderr.write(`[server] ${chunk.toString()}`));
  }
  const client = new Client({ name: label, version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const body = payload(result);
  if (result.isError || body?.isError || body?.status === "error") {
    throw new Error(`${name} failed: ${JSON.stringify(body)}`);
  }
  return body;
}

async function pollUntil(client, sessionId, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let cursor = 0;
  let initialization;
  let availableTools;
  let sawPermission = false;

  while (Date.now() < deadline) {
    const state = await call(client, "claude_code_check", {
      action: "poll",
      sessionId,
      cursor,
      responseMode: "full",
      pollOptions: { includeTools: true, includeProgressEvents: true },
    });
    cursor = state.nextCursor ?? cursor;
    availableTools ??= state.availableTools;
    for (const event of state.events ?? []) {
      if (event?.type === "progress" && event?.data?.type === "system_init") {
        initialization = event.data;
      }
    }
    sawPermission ||= (state.actions ?? []).some((action) => action.type === "permission");
    if (predicate(state)) return { state, cursor, initialization, availableTools, sawPermission };
    if (["idle", "error", "cancelled"].includes(state.status)) {
      throw new Error(`Session ${sessionId} ended before the expected state: ${state.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Timed out waiting for session ${sessionId}`);
}

async function waitForResult(client, sessionId, timeoutMs = RESULT_TIMEOUT_MS) {
  return pollUntil(
    client,
    sessionId,
    (state) => state.status === "idle" && state.result,
    timeoutMs
  );
}

async function runLiveFlow(tempDirectory) {
  const suffix = path.basename(tempDirectory);
  const projectMarker = `PROJECT_RULE_${suffix}`;
  const continuityToken = `CONTINUITY_${suffix}`;
  const fileToken = `FILE_${suffix}`;
  const expectedOutput = `${projectMarker}|${fileToken}|Indigo`;

  await writeFile(
    path.join(tempDirectory, "CLAUDE.md"),
    `For this verification only, the project marker is exactly ${projectMarker}.\n`
  );
  await writeFile(path.join(tempDirectory, "input.txt"), `${fileToken}\n`);
  await writeFile(
    path.join(tempDirectory, "verify-output.mjs"),
    `import { readFileSync } from "node:fs";\nconst actual = readFileSync("verification-output.txt", "utf8").trim();\nconst expected = ${JSON.stringify(expectedOutput)};\nif (actual !== expected) { throw new Error(\`expected \${expected}, received \${actual}\`); }\nconsole.log("verified");\n`
  );

  const client = await connectClient("live-agent-sdk");
  try {
    const start = await call(client, "claude_code", {
      prompt: `Remember this continuity token: ${continuityToken}. Read the project instructions and reply with the continuity token and project marker. Do not edit files or run commands in this turn.`,
      cwd: tempDirectory,
      model: MODEL,
      permissionMode: "default",
      maxTurns: 12,
      advanced: { settingSources: ["user", "project", "local"] },
    });
    assert(start.permissionMode === "default", "initial permission mode was not default");
    const first = await waitForResult(client, start.sessionId);
    const firstText = first.state.result?.result ?? "";
    assert(firstText.includes(continuityToken), "first turn did not preserve the continuity token");
    assert(firstText.includes(projectMarker), "project CLAUDE.md instruction was not observed");
    assert(first.initialization, "system/init metadata was not exposed by the MCP server");
    assert(
      first.initialization.model === MODEL,
      `effective model was ${first.initialization.model}`
    );
    assert(
      typeof first.initialization.claudeCodeVersion === "string" &&
        first.initialization.claudeCodeVersion.length > 0,
      "Claude Code version was not reported"
    );
    assert(Array.isArray(first.initialization.skills), "system/init skills were not reported");
    assert(Array.isArray(first.initialization.plugins), "system/init plugins were not reported");
    assert(
      Array.isArray(first.initialization.mcpServers),
      "system/init MCP state was not reported"
    );
    assert(Array.isArray(first.availableTools), "runtime tool discovery was not reported");

    const reply = await call(client, "claude_code_reply", {
      sessionId: start.sessionId,
      prompt:
        "First call AskUserQuestion and ask which verification color should be written, with Indigo and Amber as options. Wait for the answer. Then read input.txt, combine the project marker, file token, and selected color with | separators, write the exact value to verification-output.txt, and run node verify-output.mjs. Finish by reporting the continuity token from the first turn.",
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      effort: "low",
    });
    assert(reply.sessionId === start.sessionId, "reply did not reuse the original session");
    assert(reply.permissionMode === "bypassPermissions", "reply permission change was not applied");

    const waiting = await pollUntil(
      client,
      start.sessionId,
      (state) => (state.actions ?? []).some((action) => action.type === "user_question"),
      QUESTION_TIMEOUT_MS
    );
    assert(!waiting.sawPermission, "bypassPermissions unexpectedly emitted a permission action");
    const questionAction = waiting.state.actions.find((action) => action.type === "user_question");
    assert(questionAction.questions?.length > 0, "AskUserQuestion contained no questions");
    const question = questionAction.questions[0];
    const optionLabels = question.options.map((option) => option.label);
    assert(
      optionLabels.includes("Indigo") && optionLabels.includes("Amber"),
      `AskUserQuestion options were ${optionLabels.join(", ")}`
    );
    assert(question.multiSelect === false, "AskUserQuestion unexpectedly allowed multiple answers");
    const questionText = question.question;
    await call(client, "claude_code_check", {
      action: "respond_user_input",
      sessionId: start.sessionId,
      requestId: questionAction.requestId,
      answers: { [questionText]: "Indigo" },
      response: "Indigo",
      annotations: {
        [questionText]: { preview: "Indigo", notes: "Automated live verification answer" },
      },
    });

    const second = await waitForResult(client, start.sessionId);
    assert(!second.sawPermission, "bypassPermissions emitted a permission action after answering");
    assert(
      second.state.result?.permissionMode === "bypassPermissions",
      "final result lost the effective reply permission mode"
    );
    assert(
      second.state.result?.model === MODEL,
      `final result model was ${second.state.result?.model}`
    );
    assert(
      (second.state.result?.result ?? "").includes(continuityToken),
      "reply did not retain first-turn context"
    );
    assert(
      (await readFile(path.join(tempDirectory, "verification-output.txt"), "utf8")).trim() ===
        expectedOutput,
      "Claude did not produce the verified file content"
    );

    return {
      sessionId: start.sessionId,
      model: second.state.result.model,
      claudeCodeVersion: first.initialization.claudeCodeVersion,
      permissionModes: ["default", "bypassPermissions"],
      askUserQuestion: true,
      runtimeTools: first.availableTools.length,
      skills: first.initialization.skills.length,
      plugins: first.initialization.plugins.length,
      mcpServers: first.initialization.mcpServers.length,
    };
  } finally {
    await client.close();
  }
}

async function verifyServerRestart(tempDirectory) {
  const client = await connectClient("live-agent-sdk-restart");
  try {
    const start = await call(client, "claude_code", {
      prompt: "Reply with exactly SERVER_RESTART_OK and do not use tools.",
      cwd: tempDirectory,
      permissionMode: "default",
      maxTurns: 2,
      advanced: { settingSources: [] },
    });
    const completed = await waitForResult(client, start.sessionId);
    assert(
      (completed.state.result?.result ?? "").trim() === "SERVER_RESTART_OK",
      "a new session after MCP server restart did not complete"
    );
    return { sessionId: start.sessionId, result: "SERVER_RESTART_OK" };
  } finally {
    await client.close();
  }
}

async function main() {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "delegate-claude-live-"));
  try {
    const live = await runLiveFlow(tempDirectory);
    const restart = await verifyServerRestart(tempDirectory);
    process.stdout.write(`${JSON.stringify({ ok: true, live, restart }, null, 2)}\n`);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exitCode = 1;
});
