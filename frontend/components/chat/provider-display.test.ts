import { describe, expect, test } from "bun:test";
import { providerDisplayName } from "./provider-display";

describe("providerDisplayName", () => {
  test("maps the gateway wire id to the product name", () => {
    // The gateway registers under the coupled wire name "skynet-knowledge"
    // (SERVER_INFO, mcp registration, permission prefixes, retained sandboxes);
    // only the DISPLAYED label changes, never the wire value.
    expect(providerDisplayName("skynet-knowledge")).toBe("useAgent");
  });

  test("passes genuine providers and other ids through unchanged", () => {
    for (const provider of ["opencode", "claude", "codex", "pi", "github", "skynet", "skynet-memory"]) {
      expect(providerDisplayName(provider)).toBe(provider);
    }
  });

  test("passes a null provider through", () => {
    expect(providerDisplayName(null)).toBeNull();
  });
});
