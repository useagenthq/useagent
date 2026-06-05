import type {
  HarnessAdapter,
  HarnessCapabilities,
  HarnessCheckpoint,
  HarnessOperationResult,
  HarnessReconciliation,
  HarnessSessionHandle,
} from "./types";
import { cancelAcpSession } from "./acp-server";
import { errorMessage } from "../util/error-message";

// ---------------------------------------------------------------------------
// Claude/Codex ACP control seam (Slice 2). Gives the ACP engines the SAME typed
// HarnessAdapter surface OpenCode has (capabilities / cancel / reconcile) without
// changing EngineAdapter.run — turns still run through acp-server.ts.
//
// HONESTY over aspiration (Slice 2 exit gate + Section 5 robustness verdict): the
// capability map describes what the useAgent ACP path ACTUALLY implements today, not
// what the ACP wire protocol could support upstream. Control operations that are
// not wired return a typed `unsupported_capability` result - never a silent no-op
// and never an OpenCode-shaped fabrication. Native `session/cancel` is wired;
// ACP history reconcile after a backend restart is not implemented, so
// reconcile is honestly unsupported (Section 4 "ACP recovery remains weaker").
// ---------------------------------------------------------------------------

/** What the resident ACP relay (acp-server.ts) implements right now:
 *  - session/new + session/load reuse the native session across turns  -> resume
 *  - agent_message_chunk + tool_call/tool_call_update stream as parts   -> streaming
 *  Everything else is deliberately false: no ACP history reconcile after restart,
 *  no child-session emitter (ACP has none),
 *  no approvals/questions surfacing (runs yolo), no reasoning/plan/patch/usage
 *  translation. These flip to true only when the corresponding path is real. */
const ACP_CAPABILITIES: HarnessCapabilities = {
  resume: true,
  cancel: true, // native session/cancel IS wired (Slice 4 + reconcile): see cancel() below
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

    // Native session/cancel IS wired (Slice 4 + reconcile): find the live resident relay for this
    // (sandbox, session) and send a targeted ACP `session/cancel`. Reports the truth - `ok` when
    // the cancel was sent, a classified error when no live relay holds the session (e.g. it already
    // settled / the sandbox is gone), never a fabricated ok or a stale unsupported_capability.
    async cancel(
      handle: HarnessSessionHandle,
      _reason: string,
    ): Promise<HarnessOperationResult> {
      try {
        const sent = await cancelAcpSession(handle.sandboxId, handle.sessionId);
        return sent ? { status: "ok" } : { status: "error", code: "session_invalid", message: "no live ACP relay holds this session" };
      } catch (e) {
        return { status: "error", code: "provider_error", message: errorMessage(e) };
      }
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
