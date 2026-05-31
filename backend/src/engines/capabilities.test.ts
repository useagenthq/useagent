import { describe, expect, test } from "bun:test";
import { sessionCapabilities } from "./capabilities";

// Phase 6: the ONE negotiated capability map is produced HERE (backend), mapping engine behavior +
// runtime resources truthfully - React never checks a provider name.
describe("sessionCapabilities (truthful per-engine + resource-driven)", () => {
  const res = { desktop: false, knowledgeTools: false };

  test("shared truths hold for every engine (streaming/tools/commands/terminal/stop/resume)", () => {
    for (const e of ["opencode", "claude", "codex"]) {
      const c = sessionCapabilities(e, res);
      expect(c.streamingText).toBe(true);
      expect(c.toolProgress).toBe(true);
      expect(c.commands).toBe(true);
      expect(c.directTerminal).toBe(true);
      expect(c.stop).toBe(true);
      expect(c.resume).toBe(true);
    }
  });

  test("OpenCode-only truths: nativeEmbed, plans, usage, reconcile; selectable-model truths; ACP: close", () => {
    const oc = sessionCapabilities("opencode", res);
    expect(oc.nativeEmbed).toBe(true);
    expect(oc.plans).toBe(true);
    expect(oc.usage).toBe(true);
    expect(oc.reconcile).toBe(true);
    expect(oc.modelSelection).toBe(true); // opencode is an any-model sandbox
    expect(oc.close).toBe(false); // opencode stays resident
    expect(oc.nativeChildProjection).toBe(true);
    expect(oc.gatewayChildSessions).toBe(true);
    expect(oc.reasoning).toBe(true);
    expect(oc.fileDiffs).toBe(true);

    const codex = sessionCapabilities("codex", res);
    expect(codex.modelSelection).toBe(true); // Codex accepts an explicit backend-policy model id

    for (const e of ["claude", "codex"]) {
      const c = sessionCapabilities(e, res);
      expect(c.nativeEmbed).toBe(false); // no opencode web embed
      expect(c.plans).toBe(false);
      expect(c.usage).toBe(false);
      expect(c.reconcile).toBe(false); // ACP control adapter is unsupported
      expect(c.close).toBe(true);
      expect(c.nativeChildProjection).toBe(false); // no native child-session emitter
      expect(c.gatewayChildSessions).toBe(true); // gateway tools are engine-independent
      expect(c.reasoning).toBe(false);
      expect(c.fileDiffs).toBe(false);
    }
    expect(sessionCapabilities("claude", res).modelSelection).toBe(false);
  });

  test("legacy aliases normalize (daytona->opencode, claude-sdk->claude)", () => {
    expect(sessionCapabilities("daytona", res).nativeEmbed).toBe(true);
    expect(sessionCapabilities("claude-sdk", res).nativeEmbed).toBe(false);
  });

  test("runtime resources are caller-truth (desktop / knowledgeTools)", () => {
    expect(sessionCapabilities("opencode", { desktop: true, knowledgeTools: false }).desktop).toBe(true);
    expect(sessionCapabilities("opencode", { desktop: false, knowledgeTools: true }).knowledgeTools).toBe(true);
    expect(sessionCapabilities("claude", { desktop: false, knowledgeTools: false }).desktop).toBe(false); // cold ACP sandbox
  });

  test("non-T3 approvals stay false while OpenCode advertises its wired question flow", () => {
    for (const e of ["opencode", "claude", "codex"]) {
      expect(sessionCapabilities(e, res).approvals).toBe(false);
    }
    expect(sessionCapabilities("opencode", res).questions).toBe(true);
    expect(sessionCapabilities("claude", res).questions).toBe(false);
    expect(sessionCapabilities("codex", res).questions).toBe(false);
  });

  test("T3 advertises only the canonical surfaces its orchestration adapter wires", () => {
    const capabilities = sessionCapabilities("codex", {
      ...res,
      runtimeOrchestration: true,
    });
    expect(capabilities).toMatchObject({
      approvals: true,
      questions: true,
      nativeChildProjection: true,
      gatewayChildSessions: true,
      reasoning: true,
      plans: true,
      usage: true,
      reconcile: true,
      nativeEmbed: false,
    });
  });
});
