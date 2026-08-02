import { describe, expect, it } from "vitest";
import { toToolErrorText } from "../src/utils/tool-error.js";

describe("toToolErrorText", () => {
  it("classifies a non-Error string as INTERNAL", () => {
    expect(toToolErrorText("executor failed")).toBe("Error [INTERNAL]: executor failed");
  });

  it("preserves an already classified error string", () => {
    const classified = "Error [INVALID_ARGUMENT]: invalid cwd";

    expect(toToolErrorText(classified)).toBe(classified);
  });

  it("classifies an unclassified Error message as INTERNAL", () => {
    expect(toToolErrorText(new Error("executor failed"))).toBe("Error [INTERNAL]: executor failed");
  });
});
