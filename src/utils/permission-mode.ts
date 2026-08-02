import type { PermissionMode } from "../types.js";
import { ErrorCode } from "../types.js";
import { DelegateError, structuredError } from "./structured-error.js";

export function validatePermissionMode(
  permissionMode: PermissionMode | undefined,
  allowDangerouslySkipPermissions: boolean | undefined,
  inheritedMode: PermissionMode = "default",
  inheritedDangerousFlag = false
): { permissionMode: PermissionMode; allowDangerouslySkipPermissions?: true } {
  const effectiveMode = permissionMode ?? inheritedMode;
  const effectiveFlag =
    allowDangerouslySkipPermissions ??
    (permissionMode === undefined ? inheritedDangerousFlag : false);

  if (effectiveMode === "bypassPermissions") {
    if (effectiveFlag !== true) {
      throw new DelegateError(
        structuredError(
          ErrorCode.INVALID_ARGUMENT,
          "permissionMode 'bypassPermissions' requires allowDangerouslySkipPermissions=true in the same request."
        )
      );
    }
    return { permissionMode: effectiveMode, allowDangerouslySkipPermissions: true };
  }

  if (effectiveFlag === true) {
    throw new DelegateError(
      structuredError(
        ErrorCode.INVALID_ARGUMENT,
        "allowDangerouslySkipPermissions=true is valid only with permissionMode 'bypassPermissions'."
      )
    );
  }
  return { permissionMode: effectiveMode };
}
