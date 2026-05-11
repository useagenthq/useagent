import { describe, expect, test } from "bun:test";
import { opencodeAssistantError } from "./opencode-message";

describe("opencodeAssistantError", () => {
  test("returns null when the assistant has no structured error", () => {
    expect(opencodeAssistantError(undefined)).toBeNull();
    expect(opencodeAssistantError(null)).toBeNull();
  });

  test("surfaces the stable provider name and message", () => {
    expect(
      opencodeAssistantError({
        name: "ProviderAuthError",
        data: { message: "provider key is missing" },
      }),
    ).toBe("ProviderAuthError: provider key is missing");
  });

  test("redacts signed sandbox capabilities from upstream messages", () => {
    expect(
      opencodeAssistantError({
        name: "APIError",
        data: { message: "bad token v1.cGF5bG9hZA.c2lnbmF0dXJl" },
      }),
    ).toBe("APIError: bad token <capability>");
  });
});
