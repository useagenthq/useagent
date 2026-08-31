import {
  providerProtocolIdentity,
  providerDriverHarnessCapabilities,
  type HarnessAdapter,
  type HarnessOperationResult,
  type HarnessSessionHandle,
} from "@useagent/agent-harness/control";
import { assertNever } from "../util/exhaustive";
import {
  opencodeProviderDriver,
  reconcileOpencodeRun,
} from "./opencode-server";

/** Compatibility control projection over the authoritative ProviderDriver. */
export const opencodeHarness: HarnessAdapter = {
  provider: "opencode",
  capabilities: () => providerDriverHarnessCapabilities(opencodeProviderDriver),
  cancel(handle: HarnessSessionHandle, reason: string): Promise<HarnessOperationResult> {
    return opencodeProviderDriver.cancel({
      provider: opencodeProviderDriver.provider,
      nativeSessionId: handle.sessionId,
      runtime: { kind: "sandbox", id: handle.sandboxId },
      protocolVersion:
        handle.protocol ?? providerProtocolIdentity(opencodeProviderDriver.descriptor.protocol),
      capabilities: opencodeProviderDriver.descriptor.capabilities,
      generation: handle.generation ?? opencodeProviderDriver.descriptor.sessionGeneration as number,
    }, reason);
  },
  async reconcile(handle, checkpoint) {
    const result = await reconcileOpencodeRun({
      sandboxId: handle.sandboxId,
      sessionId: handle.sessionId,
      sinceMs: checkpoint?.sinceMs ?? 0,
    });
    switch (result.outcome) {
      case "completed": return { status: "completed", summary: result.summary };
      case "in_progress": return { status: "in_progress", events: result.events };
      case "no_new_message": return { status: "no_change" };
      case "unreachable": return { status: "unreachable" };
      default: return assertNever(result, "unhandled opencode reconcile outcome");
    }
  },
};
