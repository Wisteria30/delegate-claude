import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock fs/child_process so tests are deterministic and cross-platform.
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { checkWindowsBashAvailability, findGitBash } from "../src/utils/windows.js";

const existsSyncMock = vi.mocked(existsSync);
const execSyncMock = vi.mocked(execSync);

const PROGRAM_FILES_GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";

// The module always uses win32 semantics, so compare probed paths in that form.
const winPath = (p: unknown) => String(p).replace(/\//g, "\\");

// Only one Git for Windows installation exists, at the default ProgramFiles root.
function mockOnlyProgramFilesGitBash(): void {
  process.env.ProgramFiles = "C:\\Program Files";
  delete process.env.ProgramW6432;
  delete process.env["ProgramFiles(x86)"];
  existsSyncMock.mockImplementation((p) => winPath(p) === PROGRAM_FILES_GIT_BASH);
}

describe("windows utils", () => {
  const originalPlatform = process.platform;
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    process.env = { ...originalEnv };
    // Force Windows behavior for these tests
    Object.defineProperty(process, "platform", { value: "win32" });
  });

  afterEach(() => {
    process.env = originalEnv;
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it("findGitBash prefers CLAUDE_CODE_GIT_BASH_PATH and trims/dequotes", () => {
    process.env.CLAUDE_CODE_GIT_BASH_PATH = ' "C:\\Program Files\\Git\\bin\\bash.exe" ';
    existsSyncMock.mockImplementation((p) => String(p).includes("bash.exe"));

    expect(findGitBash()).toContain("bash.exe");
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it("findGitBash does not search for another path when the explicit path is invalid", () => {
    process.env.CLAUDE_CODE_GIT_BASH_PATH = "C:\\missing\\bash.exe";
    mockOnlyProgramFilesGitBash();

    expect(findGitBash()).toBeNull();
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid explicit path before server startup without replacing it", () => {
    process.env.CLAUDE_CODE_GIT_BASH_PATH = "C:\\missing\\bash.exe";
    mockOnlyProgramFilesGitBash();

    expect(() => checkWindowsBashAvailability()).toThrow(
      "CLAUDE_CODE_GIT_BASH_PATH does not point to an existing file."
    );
    expect(process.env.CLAUDE_CODE_GIT_BASH_PATH).toBe("C:\\missing\\bash.exe");
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it("findGitBash derives root from cmd\\git.exe and finds <root>\\bin\\bash.exe", () => {
    delete process.env.CLAUDE_CODE_GIT_BASH_PATH;
    execSyncMock.mockReturnValue(
      "C:\\Program Files\\Git\\cmd\\git.exe\r\nC:\\Windows\\System32\\git.exe\r\n"
    );

    existsSyncMock.mockImplementation((p) => winPath(p).endsWith(PROGRAM_FILES_GIT_BASH));

    const bash = findGitBash();
    expect(bash).toBe(PROGRAM_FILES_GIT_BASH);
  });

  it("findGitBash ignores WSL bash.exe and falls back to git-derived locations", () => {
    delete process.env.CLAUDE_CODE_GIT_BASH_PATH;
    delete process.env.ProgramW6432;
    delete process.env.ProgramFiles;
    delete process.env["ProgramFiles(x86)"];

    execSyncMock.mockImplementation((cmd) => {
      if (String(cmd).toLowerCase().includes("where bash")) {
        return "C:\\Windows\\System32\\bash.exe\r\n";
      }
      if (String(cmd).toLowerCase().includes("where git")) {
        return "C:\\Program Files\\Git\\cmd\\git.exe\r\n";
      }
      return "";
    });

    existsSyncMock.mockImplementation(
      (p) =>
        winPath(p) === "C:\\Windows\\System32\\bash.exe" || winPath(p) === PROGRAM_FILES_GIT_BASH
    );

    expect(findGitBash()).toBe(PROGRAM_FILES_GIT_BASH);
  });

  it("findGitBash prefers git-derived bash.exe over other bash.exe in PATH", () => {
    delete process.env.CLAUDE_CODE_GIT_BASH_PATH;
    delete process.env.ProgramW6432;
    delete process.env.ProgramFiles;
    delete process.env["ProgramFiles(x86)"];

    execSyncMock.mockImplementation((cmd) => {
      if (String(cmd).toLowerCase().includes("where bash")) {
        return "C:\\msys64\\usr\\bin\\bash.exe\r\n";
      }
      if (String(cmd).toLowerCase().includes("where git")) {
        return "C:\\Program Files\\Git\\cmd\\git.exe\r\n";
      }
      return "";
    });

    existsSyncMock.mockImplementation(
      (p) =>
        winPath(p) === "C:\\msys64\\usr\\bin\\bash.exe" || winPath(p) === PROGRAM_FILES_GIT_BASH
    );

    expect(findGitBash()).toBe(PROGRAM_FILES_GIT_BASH);
  });

  it("findGitBash falls back to default ProgramFiles location even if PATH is missing", () => {
    delete process.env.CLAUDE_CODE_GIT_BASH_PATH;
    mockOnlyProgramFilesGitBash();

    expect(findGitBash()).toBe(PROGRAM_FILES_GIT_BASH);
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it("exports an auto-detected path when no explicit path is configured", () => {
    delete process.env.CLAUDE_CODE_GIT_BASH_PATH;
    mockOnlyProgramFilesGitBash();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    checkWindowsBashAvailability();

    expect(process.env.CLAUDE_CODE_GIT_BASH_PATH).toBe(PROGRAM_FILES_GIT_BASH);
    expect(consoleError).toHaveBeenCalledWith(
      `[windows] Git Bash detected: ${PROGRAM_FILES_GIT_BASH} (set CLAUDE_CODE_GIT_BASH_PATH)`
    );
    consoleError.mockRestore();
  });

  it("keeps a valid explicit path as configured and skips detection", () => {
    process.env.CLAUDE_CODE_GIT_BASH_PATH = ` "${PROGRAM_FILES_GIT_BASH}" `;
    existsSyncMock.mockImplementation((p) => winPath(p) === PROGRAM_FILES_GIT_BASH);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    checkWindowsBashAvailability();

    expect(process.env.CLAUDE_CODE_GIT_BASH_PATH).toBe(` "${PROGRAM_FILES_GIT_BASH}" `);
    expect(consoleError).toHaveBeenCalledWith(
      `[windows] Git Bash detected: ${PROGRAM_FILES_GIT_BASH}`
    );
    expect(execSyncMock).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
