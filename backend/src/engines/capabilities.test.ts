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

  test("OpenCode-only truths: nativeEmbed, plans, usage, reconcile, modelSelection; ACP: close", () => {
    const oc = sessionCapabilities("opencode", res);
    expect(oc.nativeEmbed).toBe(true);
    expect(oc.plans).toBe(true);
    expect(oc.usage).toBe(true);
    expect(oc.reconcile).toBe(true);
    expect(oc.modelSelection).toBe(true); // opencode is an any-model sandbox
    expect(oc.close).toBe(false); // opencode stays resident
    expect(oc.childSessions).toBe(true);
    expect(oc.reasoning).toBe(true);
    expect(oc.fileDiffs).toBe(true);

    for (const e of ["claude", "codex"]) {
      const c = sessionCapabilities(e, res);
      expect(c.nativeEmbed).toBe(false); // no opencode web embed
      expect(c.plans).toBe(false);
      expect(c.usage).toBe(false);
      expect(c.reconcile).toBe(false); // ACP control adapter is unsupported
      expect(c.modelSelection).toBe(false); // ACP runs a fixed model - no fake model picker
      expect(c.close).toBe(true);
      expect(c.childSessions).toBe(false);
      expect(c.reasoning).toBe(false);
      expect(c.fileDiffs).toBe(false);
    }
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

  test("approvals/questions are false (yolo / fail-closed) - never a fake approval UI", () => {
    for (const e of ["opencode", "claude", "codex"]) {
      expect(sessionCapabilities(e, res).approvals).toBe(false);
      expect(sessionCapabilities(e, res).questions).toBe(false);
    }
  });
});
