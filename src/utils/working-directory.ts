import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ErrorCode } from "../types.js";
import { normalizeWindowsPathLike } from "./normalize-windows-path.js";

export function normalizeAndAssertWorkingDirectory(
  cwd: string,
  contextLabel: string,
  portableTmpAlias: "preserve" | "resolve"
): string {
  const normalizedCwd = normalizeWindowsPathLike(cwd);
  const resolvedCwd =
    portableTmpAlias === "resolve" ? resolvePortableTmpAlias(normalizedCwd) : normalizedCwd;
  if (!existsSync(resolvedCwd)) {
    throw new Error(
      `Error [${ErrorCode.INVALID_ARGUMENT}]: ${contextLabel} path does not exist: ${resolvedCwd}`
    );
  }
  try {
    const stat = statSync(resolvedCwd);
    if (!stat.isDirectory()) {
      throw new Error(
        `Error [${ErrorCode.INVALID_ARGUMENT}]: ${contextLabel} must be a directory: ${resolvedCwd}`
      );
    }
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("Error [")) throw err;
    const detail = err instanceof Error ? ` (${err.message})` : "";
    throw new Error(
      `Error [${ErrorCode.INVALID_ARGUMENT}]: ${contextLabel} is not accessible: ${resolvedCwd}${detail}`
    );
  }
  return resolvedCwd;
}

function resolvePortableTmpAlias(cwd: string): string {
  if (process.platform !== "win32") return cwd;

  const normalized = cwd.replace(/\\/g, "/");
  if (normalized === "/tmp") return os.tmpdir();
  if (normalized.startsWith("/tmp/")) {
    return path.join(os.tmpdir(), normalized.slice("/tmp/".length));
  }
  return cwd;
}
