import { describe, expect, test } from "bun:test";
import { providerDisplayName } from "./provider-display";
import { LEGACY_TOOL_SERVER_IDS, PLATFORM_EVENT_LANES } from "@useagent/agent-harness/canonical";

describe("providerDisplayName", () => {
  test("maps the gateway wire id to the product name", () => {
    expect(providerDisplayName("useagent")).toBe("UseAgent");
    expect(providerDisplayName("useagent-browser")).toBe("UseAgent Browser");
    expect(providerDisplayName(LEGACY_TOOL_SERVER_IDS.gateway)).toBe("UseAgent");
    expect(providerDisplayName(LEGACY_TOOL_SERVER_IDS.browser)).toBe("UseAgent Browser");
  });

  test("passes genuine providers and other ids through unchanged", () => {
    for (const provider of [
      "opencode",
      "claude",
      "codex",
      "pi",
      "github",
      PLATFORM_EVENT_LANES.platform,
      PLATFORM_EVENT_LANES.memory,
    ]) {
      expect(providerDisplayName(provider)).toBe(provider);
    }
  });

  test("passes a null provider through", () => {
    expect(providerDisplayName(null)).toBeNull();
  });
});
