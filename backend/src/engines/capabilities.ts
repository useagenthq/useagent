import type { NegotiatedCapabilities } from "@skynet/agent-harness/canonical";
import { canonicalEngine } from "./engine-alias";

// ---------------------------------------------------------------------------
// Provider capability NEGOTIATION -> the ONE `NegotiatedCapabilities` map (Phase 6). This is the
// single place engine behavior + runtime resources are mapped into the capability contract the
// UI reads; React never checks a provider name. A capability is TRUE only when it is actually
// wired/provisioned - an absent surface reads false and is honestly omitted.
// ---------------------------------------------------------------------------

/** Runtime resources that are NOT pure protocol negotiation - the caller knows whether they are
 *  actually provisioned for THIS session (a cold ACP sandbox has no VNC; the tool gateway is only
 *  loaded when a reachable public URL is configured). */
export interface CapabilityResources {
  /** A VNC/desktop resource is provisioned in the session's sandbox. */
  readonly desktop: boolean;
  /** The provider actually loaded the Skynet knowledge MCP for this session. */
  readonly knowledgeTools: boolean;
}

/** The truthful negotiated capability map for a real session of `engine`, given its runtime
 *  resources. Pure + total; every field is set explicitly (no `false`-by-omission surprises). */
export function sessionCapabilities(engine: string, res: CapabilityResources): NegotiatedCapabilities {
  const e = canonicalEngine(engine); // normalize legacy aliases (daytona->opencode, claude-sdk->claude)
  const isOpencode = e === "opencode";
  return {
    // Streaming/tools/files/commands/terminal/children/reasoning are real for every current engine.
    streamingText: true,
    toolProgress: true,
    fileDiffs: true,
    commands: true,
    directTerminal: true, // the thread sandbox has a terminal for every engine
    childSessions: true, // task-tool subagents
    reasoning: true,
    resume: true, // opencode continuation / ACP session/load
    load: true,
    stop: true, // opencode POST /abort · ACP session/cancel (both wired)
    // Honest per-engine differences:
    plans: isOpencode, // only opencode emits plan.updated today
    usage: isOpencode, // only opencode captures step-finish usage today
    modelSelection: isOpencode, // only opencode is an any-model sandbox; ACP engines run a fixed model

    reconcile: isOpencode, // opencode has authoritative-history reconcile; ACP control adapter is unsupported
    close: !isOpencode, // ACP session/close; opencode stays resident
    nativeEmbed: isOpencode, // only opencode has the native web-app embed (Live)
    approvals: false, // one-shot yolo / fail-closed ACP permissions -> no approval UI flow yet
    questions: false,
    // Runtime resources (caller-provided truth):
    desktop: res.desktop,
    knowledgeTools: res.knowledgeTools,
  };
}
