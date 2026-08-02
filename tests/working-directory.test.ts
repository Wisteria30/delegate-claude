import { beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => true),
  statSync: vi.fn(() => ({ isDirectory: () => true })),
}));

import { normalizeAndAssertWorkingDirectory } from "../src/utils/working-directory.js";

describe("normalizeAndAssertWorkingDirectory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(statSync).mockReturnValue({ isDirectory: () => true } as ReturnType<typeof statSync>);
  });

  it("preserves start paths and resolves stored paths for both reply call sites", () => {
    const nativeTmp = process.platform === "win32" ? "C:\\native-tmp" : "/native-tmp";
    const tmpdir = vi.spyOn(os, "tmpdir").mockReturnValue(nativeTmp);
    try {
      const storedPath = "/tmp/session-123";

      expect(normalizeAndAssertWorkingDirectory(storedPath, "cwd", "preserve", "win32")).toBe(
        storedPath
      );
      expect(normalizeAndAssertWorkingDirectory(storedPath, "cwd", "resolve", "win32")).toBe(
        path.join(nativeTmp, "session-123")
      );
    } finally {
      tmpdir.mockRestore();
    }
  });

  it("rejects a missing path before reading its metadata", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(() => normalizeAndAssertWorkingDirectory("/missing", "cwd", "preserve")).toThrow(
      "Error [INVALID_ARGUMENT]: cwd path does not exist: /missing"
    );
    expect(statSync).not.toHaveBeenCalled();
  });

  it("rejects a path that is not a directory", () => {
    vi.mocked(statSync).mockReturnValue({ isDirectory: () => false } as ReturnType<
      typeof statSync
    >);
    expect(() => normalizeAndAssertWorkingDirectory("/file", "cwd", "preserve")).toThrow(
      "Error [INVALID_ARGUMENT]: cwd must be a directory: /file"
    );
  });

  it("reports a metadata read failure as an inaccessible path", () => {
    vi.mocked(statSync).mockImplementation(() => {
      throw new Error("permission denied");
    });
    expect(() => normalizeAndAssertWorkingDirectory("/blocked", "cwd", "preserve")).toThrow(
      "Error [INVALID_ARGUMENT]: cwd is not accessible: /blocked (permission denied)"
    );
  });
});
