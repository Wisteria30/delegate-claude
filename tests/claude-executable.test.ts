import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveExplicitClaudeExecutable } from "../src/utils/claude-executable.js";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "delegate-claude-exec-"));
  temporaryDirectories.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("explicit Claude Code executable validation", () => {
  it("resolves a relative executable path from the session cwd", () => {
    const cwd = temporaryDirectory();
    const filePath = path.join(cwd, "bin", process.platform === "win32" ? "claude.cmd" : "claude");
    mkdirSync(path.dirname(filePath));
    writeFileSync(filePath, process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n");
    if (process.platform !== "win32") chmodSync(filePath, 0o755);

    expect(resolveExplicitClaudeExecutable(path.join("bin", path.basename(filePath)), cwd)).toBe(
      filePath
    );
  });

  it("accepts a readable JavaScript entrypoint without an executable bit", () => {
    const cwd = temporaryDirectory();
    const filePath = path.join(cwd, "claude.js");
    writeFileSync(filePath, "export {};\n");
    if (process.platform !== "win32") chmodSync(filePath, 0o644);

    expect(resolveExplicitClaudeExecutable(filePath, cwd)).toBe(filePath);
  });

  it("rejects a missing path", () => {
    const cwd = temporaryDirectory();
    const missing = path.join(cwd, "missing-claude");

    expect(() => resolveExplicitClaudeExecutable(missing, cwd)).toThrow(
      "Error [INVALID_ARGUMENT]: pathToClaudeCodeExecutable is not a launchable file"
    );
  });

  it("rejects a non-executable native file on POSIX", () => {
    if (process.platform === "win32") return;

    const cwd = temporaryDirectory();
    const filePath = path.join(cwd, "claude");
    writeFileSync(filePath, "#!/bin/sh\n");
    chmodSync(filePath, 0o644);

    expect(() => resolveExplicitClaudeExecutable(filePath, cwd)).toThrow(
      "Error [INVALID_ARGUMENT]: pathToClaudeCodeExecutable is not a launchable file"
    );
  });
});
