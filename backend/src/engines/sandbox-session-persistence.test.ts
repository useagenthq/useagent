import { describe, expect, test } from "bun:test";
import type { HarnessSession } from "@useagent/agent-harness/canonical";
import { unsupportedExecutionCapabilitySnapshot } from "./execution-capabilities";
import { createSandboxSessionRevealPersister } from "./sandbox";

describe("CLI session reveal persistence", () => {
  test("commits the first revealed session without waiting for terminal output", async () => {
    const saved: HarnessSession[] = [];
    const persist = createSandboxSessionRevealPersister({
      provider: "codex",
      sandboxId: "sandbox-1",
      executionCapabilities: unsupportedExecutionCapabilitySnapshot("sandbox", "/work"),
      saveProviderSession: async (session) => { saved.push(session); },
    });

    await persist(null);
    await persist("session-first-frame");
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      nativeSessionId: "session-first-frame",
      protocolVersion: "cli-jsonl/codex",
      runtime: { kind: "sandbox", id: "sandbox-1" },
      generation: 1,
    });

    await persist("session-first-frame");
    expect(saved).toHaveLength(1);
  });
});
