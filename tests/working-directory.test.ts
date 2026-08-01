import { describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => true),
  statSync: vi.fn(() => ({ isDirectory: () => true })),
}));

import { normalizeAndAssertWorkingDirectory } from "../src/utils/working-directory.js";

describe("normalizeAndAssertWorkingDirectory", () => {
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
});
