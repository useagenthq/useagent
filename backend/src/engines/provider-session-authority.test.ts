import { describe, expect, test } from "bun:test";
import type { ProviderSessionBinding } from "@useagent/agent-harness/canonical";
import { providerSessionAuthIsCurrent } from "./provider-session-authority";

const binding = (authEpoch: string | null): ProviderSessionBinding => ({
  version: 1,
  provider: "codex",
  nativeSessionId: "session-1",
  protocol: "t3-orchestration/useagent-runtime-v7",
  generation: 2,
  runtime: { kind: "sandbox", id: "sandbox-1" },
  authEpoch,
});

describe("provider session credential authority", () => {
  test("accepts gateway sessions and requires the exact live subscription epoch", async () => {
    expect(await providerSessionAuthIsCurrent({
      binding: binding(null), orgId: null, userId: null,
    })).toBe(true);

    for (const currentEpoch of ["epoch-1", "epoch-2", null]) {
      expect(await providerSessionAuthIsCurrent(
        { binding: binding("epoch-1"), orgId: "org-1", userId: "user-1" },
        async () => currentEpoch
          ? { authMethod: "chatgpt_oauth", mode: "managed_codex_app_server", connectionId: "pc-1", authEpoch: currentEpoch, codexHome: "/tmp/codex", metadata: {} }
          : null,
      )).toBe(currentEpoch === "epoch-1");
    }
  });
});
