import type { ExecutionCapabilitySnapshot } from "@useagent/agent-harness/canonical";
import { sessionCapabilities } from "./capabilities";
import type { EngineRunContext } from "./types";

export function createSandboxSessionRevealPersister(input: {
  readonly provider: "claude" | "codex";
  readonly sandboxId: string;
  readonly executionCapabilities: ExecutionCapabilitySnapshot;
  readonly saveProviderSession?: EngineRunContext["saveProviderSession"];
}): (sessionId: string | null) => Promise<void> {
  let persistedSessionId: string | null = null;
  return async (sessionId) => {
    if (!sessionId || sessionId === persistedSessionId) return;
    if (!input.saveProviderSession) {
      throw new Error("CLI provider session persistence is unavailable");
    }
    await input.saveProviderSession({
      provider: input.provider,
      nativeSessionId: sessionId,
      runtime: { kind: "sandbox", id: input.sandboxId },
      protocolVersion: `cli-jsonl/${input.provider}`,
      capabilities: sessionCapabilities(input.provider, {
        desktop: false,
        knowledgeTools: false,
      }),
      executionCapabilities: input.executionCapabilities,
      generation: 1,
    });
    persistedSessionId = sessionId;
  };
}
