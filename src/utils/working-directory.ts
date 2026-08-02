import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ErrorCode } from "../types.js";
import { normalizeWindowsPathLike } from "./normalize-windows-path.js";

export function normalizeAndAssertWorkingDirectory(
  cwd: string,
  contextLabel: string,
  portableTmpAlias: "preserve" | "resolve",
  platform: NodeJS.Platform = process.platform
): string {
  // `claude_code` validates the literal client-supplied path ("preserve"); both `claude_code_reply`
  // entry points map a `/tmp` prefix onto the native temp dir ("resolve"). On win32 that means a
  // session started at `/tmp` can validate against `C:\tmp` but reply against `os.tmpdir()`.
  const normalizedCwd = normalizeWindowsPathLike(cwd, platform);
  const resolvedCwd =
    portableTmpAlias === "resolve"
      ? resolvePortableTmpAlias(normalizedCwd, platform)
      : normalizedCwd;
  if (!existsSync(resolvedCwd)) {
    throw new Error(
      `Error [${ErrorCode.INVALID_ARGUMENT}]: ${contextLabel} path does not exist: ${resolvedCwd}`
    );
  }
  let stat;
  try {
    stat = statSync(resolvedCwd);
  } catch (err: unknown) {
    const detail = err instanceof Error ? ` (${err.message})` : "";
    throw new Error(
      `Error [${ErrorCode.INVALID_ARGUMENT}]: ${contextLabel} is not accessible: ${resolvedCwd}${detail}`,
      { cause: err }
    );
  }
  if (!stat.isDirectory()) {
    throw new Error(
      `Error [${ErrorCode.INVALID_ARGUMENT}]: ${contextLabel} must be a directory: ${resolvedCwd}`
    );
  }
  return resolvedCwd;
}

function resolvePortableTmpAlias(cwd: string, platform: NodeJS.Platform): string {
  if (platform !== "win32") return cwd;

  const normalized = cwd.replace(/\\/g, "/");
  if (normalized === "/tmp") return os.tmpdir();
  if (normalized.startsWith("/tmp/")) {
    return path.join(os.tmpdir(), normalized.slice("/tmp/".length));
  }
  return cwd;
}
