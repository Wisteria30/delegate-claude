import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MODEL = "claude-opus-5";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function collectMcpToolNames(jsonl) {
  const names = new Set();
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const visit = (value) => {
      if (!value || typeof value !== "object") return;
      if (
        value.type === "mcp_tool_call" &&
        value.server === "delegate-claude" &&
        typeof value.tool === "string"
      ) {
        names.add(`${value.server}/${value.tool}`);
      }
      if (
        typeof value.name === "string" &&
        value.name.includes("delegate-claude") &&
        value.name.includes("claude_code")
      ) {
        names.add(value.name);
      }
      for (const child of Object.values(value)) visit(child);
    };
    visit(event);
  }
  return [...names].sort();
}

async function main() {
  const repository = process.cwd();
  const serverEntry = path.join(repository, "dist", "index.js");
  const skillPath = path.join(repository, "skills", "delegate-claude", "SKILL.md");
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "delegate-claude-codex-"));
  const marker = `CODEX_DELEGATION_${path.basename(tempDirectory)}`;
  const expected = `${marker}|Indigo`;

  try {
    const outputSchemaPath = path.join(tempDirectory, "result.schema.json");
    const lastMessagePath = path.join(tempDirectory, "codex-result.json");
    await writeFile(
      outputSchemaPath,
      `${JSON.stringify(
        {
          type: "object",
          additionalProperties: false,
          required: ["sessionId", "question", "answer", "model", "fileVerified"],
          properties: {
            sessionId: { type: "string" },
            question: { type: "string" },
            answer: { type: "string", const: "Indigo" },
            model: { type: "string", const: MODEL },
            fileVerified: { type: "boolean", const: true },
          },
        },
        null,
        2
      )}\n`
    );
    await writeFile(
      path.join(tempDirectory, "verify-result.mjs"),
      `import { readFileSync } from "node:fs";\nconst actual = readFileSync("delegated-result.txt", "utf8").trim();\nconst expected = ${JSON.stringify(expected)};\nif (actual !== expected) throw new Error(\`expected \${expected}, received \${actual}\`);\nconsole.log("verified");\n`
    );

    const prompt = `Read and follow the delegate-claude skill at ${skillPath}. This is an isolated acceptance fixture in ${tempDirectory}; do not modify any other directory. Use only the delegate-claude MCP tools to delegate this task to Claude. Start Claude with model ${MODEL}, cwd ${tempDirectory}, permissionMode bypassPermissions, and allowDangerouslySkipPermissions true. Tell Claude to call AskUserQuestion with the exact question "Which Codex verification color should be used?" and options Indigo and Amber before doing any work. The user-provided fixture answer is already authorized as "Indigo"; when the user_question action arrives, relay that exact answer through respond_user_input without asking again. Claude must then write exactly ${expected} to delegated-result.txt and run node verify-result.mjs. Continue polling the same Claude session until its final result, inspect delegated-result.txt yourself, and return only the required JSON object. Set question to the exact question received from Claude, sessionId and model from the real MCP result, and fileVerified true only after reading the file.`;

    const result = await run(
      "codex",
      [
        "exec",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--skip-git-repo-check",
        "--json",
        "--sandbox",
        "workspace-write",
        "--cd",
        tempDirectory,
        "--output-schema",
        outputSchemaPath,
        "--output-last-message",
        lastMessagePath,
        "-c",
        'approval_policy="never"',
        "-c",
        `mcp_servers.delegate-claude.command=${JSON.stringify(process.execPath)}`,
        "-c",
        `mcp_servers.delegate-claude.args=[${JSON.stringify(serverEntry)}]`,
        "-c",
        'mcp_servers.delegate-claude.enabled_tools=["claude_code","claude_code_reply","claude_code_check","claude_code_session"]',
        "-c",
        'mcp_servers.delegate-claude.default_tools_approval_mode="approve"',
        prompt,
      ],
      { cwd: tempDirectory, env: process.env }
    );

    if (result.code !== 0) {
      throw new Error(
        `codex exec failed with status ${result.code}\nstdout:\n${result.stdout.slice(-8_000)}\nstderr:\n${result.stderr.slice(-8_000)}`
      );
    }
    const finalResult = JSON.parse(await readFile(lastMessagePath, "utf8"));
    const mcpTools = collectMcpToolNames(result.stdout);
    assert(finalResult.fileVerified === true, "Codex did not verify the delegated file");
    assert(finalResult.answer === "Indigo", "Codex did not relay the authorized answer");
    assert(finalResult.model === MODEL, `Codex reported model ${finalResult.model}`);
    assert(
      finalResult.question === "Which Codex verification color should be used?",
      `Codex reported an unexpected question: ${finalResult.question}`
    );
    let delegatedFile;
    try {
      delegatedFile = await readFile(path.join(tempDirectory, "delegated-result.txt"), "utf8");
    } catch (error) {
      throw new Error(
        `Codex reported success without a delegated file. result=${JSON.stringify(finalResult)} mcpTools=${JSON.stringify(mcpTools)} events=${result.stdout.slice(-8_000)}`,
        { cause: error }
      );
    }
    assert(delegatedFile.trim() === expected, "delegated file content was not preserved");
    assert(
      mcpTools.some((name) => name.endsWith("claude_code")),
      "Codex event stream did not record claude_code"
    );
    assert(
      mcpTools.some((name) => name.endsWith("claude_code_check")),
      "Codex event stream did not record claude_code_check"
    );

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          sessionId: finalResult.sessionId,
          model: finalResult.model,
          question: finalResult.question,
          answer: finalResult.answer,
          mcpTools,
          fileVerified: true,
        },
        null,
        2
      )}\n`
    );
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
