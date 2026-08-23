import type { NegotiatedCapabilities } from "@useagent/agent-harness/canonical";
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
  /** This provider session is owned by the canonical orchestration runtime. */
  readonly runtimeOrchestration?: boolean;
}

/** The truthful negotiated capability map for a real session of `engine`, given its runtime
 *  resources. Pure + total; every field is set explicitly (no `false`-by-omission surprises). */
export function sessionCapabilities(engine: string, res: CapabilityResources): NegotiatedCapabilities {
  const e = canonicalEngine(engine); // normalize legacy aliases (daytona->opencode, claude-sdk->claude)
  const isOpencode = e === "opencode";
  const isCodex = e === "codex";
  const isRuntime = res.runtimeOrchestration === true;
  return {
    // Streaming, tool progress, commands and the sandbox terminal are real for
    // every engine. Native reasoning/child/patch projections only exist on the
    // OpenCode protocol and the canonical runtime adapter today; legacy ACP must not
    // advertise aspirational UI surfaces.
    streamingText: true,
    toolProgress: true,
    fileDiffs: isOpencode || isRuntime,
    commands: true,
    directTerminal: true, // the thread sandbox has a terminal for every engine
    // Engine-NATIVE task-subagent projection only exists on the OpenCode protocol and the
    // canonical runtime adapter.
    nativeChildProjection: isOpencode || isRuntime,
    // The gateway child_session_* tools spawn DEFERRED serial thread turns through the product
    // command lane - engine-independent, so ACP claude/codex sessions get them too.
    gatewayChildSessions: res.knowledgeTools,
    reasoning: isOpencode || isRuntime,
    resume: true, // opencode continuation / ACP session/load
    load: true,
    stop: true, // opencode POST /abort · ACP session/cancel (both wired)
    // Honest per-engine differences:
    plans: isOpencode || isRuntime,
    usage: isOpencode || isRuntime,
    modelSelection: isOpencode || isCodex, // OpenCode uses provider ids; Codex accepts explicit backend-policy ids

    reconcile: isOpencode || isRuntime,
    close: !isOpencode && !isRuntime,
    nativeEmbed: isOpencode && !isRuntime,
    approvals: isRuntime,
    questions: isOpencode || isRuntime,
    // Runtime resources (caller-provided truth):
    desktop: res.desktop,
    knowledgeTools: res.knowledgeTools,
  };
}
