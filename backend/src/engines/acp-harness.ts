import type {
  HarnessAdapter,
  HarnessCapabilities,
  HarnessCheckpoint,
  HarnessOperationResult,
  HarnessReconciliation,
  HarnessSessionHandle,
} from "./types";

// ---------------------------------------------------------------------------
// Claude/Codex ACP control seam (Slice 2). Gives the ACP engines the SAME typed
// HarnessAdapter surface OpenCode has (capabilities / cancel / reconcile) without
// changing EngineAdapter.run — turns still run through acp-server.ts.
//
// HONESTY over aspiration (Slice 2 exit gate + Section 5 robustness verdict): the
// capability map describes what the Skynet ACP path ACTUALLY implements today, not
// what the ACP wire protocol could support upstream. Control operations that are
// not wired return a typed `unsupported_capability` result - never a silent no-op
// and never an OpenCode-shaped fabrication. Native `session/cancel` is deferred to
// Slice 4; ACP history reconcile after a backend restart is not implemented, so
// reconcile is honestly unsupported (Section 4 "ACP recovery remains weaker").
// ---------------------------------------------------------------------------

/** What the resident ACP relay (acp-server.ts) implements right now:
 *  - session/new + session/load reuse the native session across turns  -> resume
 *  - agent_message_chunk + tool_call/tool_call_update stream as parts   -> streaming
 *  Everything else is deliberately false: no native session/cancel yet (Slice 4),
 *  no ACP history reconcile after restart, no child-session emitter (ACP has none),
 *  no approvals/questions surfacing (runs yolo), no reasoning/plan/patch/usage
 *  translation. These flip to true only when the corresponding path is real. */
const ACP_CAPABILITIES: HarnessCapabilities = {
  resume: true,
  cancel: false,
  streaming: "parts",
  authoritativeHistory: false,
  childSessions: false,
  approvals: false,
  questions: false,
  reasoning: false,
  todos: false,
  patches: false,
  usage: false,
};

function makeAcpHarness(provider: string): HarnessAdapter {
  return {
    provider,

    capabilities(): HarnessCapabilities {
      return { ...ACP_CAPABILITIES };
    },

    // No native session/cancel is wired yet (Slice 4). The product Stop still works
    // via the run's AbortSignal in acp-server.ts, but that is the shared HTTP/SSE
    // abort, NOT a provider-native targeted cancel - so this typed control surface
    // reports the truth instead of claiming an ok it did not perform.
    async cancel(
      _handle: HarnessSessionHandle,
      _reason: string,
    ): Promise<HarnessOperationResult> {
      return { status: "unsupported_capability", provider, capability: "cancel" };
    },

    // ACP exposes no authoritative REST history to reconcile from after a restart,
    // so there is nothing honest to project here. Unsupported, never a fabricated
    // completed/in_progress.
    async reconcile(
      _handle: HarnessSessionHandle,
      _checkpoint?: HarnessCheckpoint,
    ): Promise<HarnessReconciliation> {
      return { status: "unsupported_capability", provider, capability: "reconcile" };
    },
  };
}

export const claudeHarness: HarnessAdapter = makeAcpHarness("claude");
export const codexHarness: HarnessAdapter = makeAcpHarness("codex");
