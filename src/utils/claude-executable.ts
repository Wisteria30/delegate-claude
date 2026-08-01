import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import { ErrorCode } from "../types.js";
import { normalizeWindowsPathLike } from "./normalize-windows-path.js";

const SDK_SCRIPT_EXTENSIONS = [".js", ".mjs", ".tsx", ".ts", ".jsx"] as const;

function isSdkScript(filePath: string): boolean {
  return SDK_SCRIPT_EXTENSIONS.some((extension) => filePath.endsWith(extension));
}

export function resolveExplicitClaudeExecutable(rawPath: string, cwd: string): string {
  if (rawPath.trim() === "") {
    throw new Error(
      `Error [${ErrorCode.INVALID_ARGUMENT}]: pathToClaudeCodeExecutable must be a non-empty path.`
    );
  }

  const normalized = normalizeWindowsPathLike(rawPath);
  const resolved = path.isAbsolute(normalized)
    ? path.normalize(normalized)
    : path.resolve(cwd, normalized);

  try {
    if (!statSync(resolved).isFile()) {
      throw new Error("not a file");
    }
    accessSync(
      resolved,
      process.platform === "win32" || isSdkScript(resolved) ? constants.R_OK : constants.X_OK
    );
  } catch {
    throw new Error(
      `Error [${ErrorCode.INVALID_ARGUMENT}]: pathToClaudeCodeExecutable is not a launchable file: ${resolved}`
    );
  }

  return resolved;
}
