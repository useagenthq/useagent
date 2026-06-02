// Slice 2 gate: the Claude/Codex control seam is HONEST. capabilities() reports
// only what the ACP path implements, and the control ops that are not wired
// (cancel until Slice 4, reconcile) return a typed `unsupported_capability` -
// never a silent ok and never an OpenCode-shaped fabricated completion.

import { describe, expect, test } from "bun:test";
import { claudeHarness, codexHarness } from "./acp-harness";
import { resolveHarness } from "./index";
import { opencodeHarness } from "./opencode-server";
import type { HarnessSessionHandle } from "./types";

const HANDLE: HarnessSessionHandle = { provider: "x", sessionId: "ses_1", sandboxId: "sbx_1" };

describe("ACP harness capabilities are honest (not aspirational)", () => {
  for (const [name, harness] of [["claude", claudeHarness], ["codex", codexHarness]] as const) {
    const caps = harness.capabilities();
    test(`${name}: provider id matches`, () => {
      expect(harness.provider).toBe(name);
    });
    test(`${name}: reports parts streaming + resume, but not the unwired surfaces`, () => {
      expect(caps.streaming).toBe("parts");
      expect(caps.resume).toBe(true);
      // Everything not implemented today must be false - no over-claiming.
      expect(caps.cancel).toBe(true); // native session/cancel IS wired (Slice 4 + reconcile)
      expect(caps.authoritativeHistory).toBe(false); // no ACP history reconcile
      expect(caps.childSessions).toBe(false); // ACP has no child-session emitter
      expect(caps.approvals).toBe(false);
      expect(caps.questions).toBe(false);
      expect(caps.reasoning).toBe(false);
      expect(caps.todos).toBe(false);
      expect(caps.patches).toBe(false);
      expect(caps.usage).toBe(false);
    });
    test(`${name}: capabilities() returns a fresh copy (not the shared const)`, () => {
      expect(harness.capabilities()).not.toBe(caps);
      expect(harness.capabilities()).toEqual(caps);
    });
  }
});

describe("ACP harness control ops are typed-unsupported, never silent success", () => {
  for (const [name, harness] of [["claude", claudeHarness], ["codex", codexHarness]] as const) {
    test(`${name}: cancel() with no live relay for the session -> classified error, never a fabricated ok`, async () => {
      // In a unit context there is no resident relay holding HANDLE's session, so a targeted
      // native cancel finds nothing to cancel and reports a classified error (not `ok`, not a
      // stale `unsupported_capability` - the capability IS wired, it just has no live session here).
      const r = await harness.cancel(HANDLE, "user stop");
      expect(r).toEqual({ status: "error", code: "session_invalid", message: "no live ACP relay holds this session" });
      expect(r.status).not.toBe("ok");
    });
    test(`${name}: reconcile() -> unsupported_capability(reconcile), never a fabricated completion`, async () => {
      const r = await harness.reconcile(HANDLE, { sinceMs: 0 });
      expect(r).toEqual({ status: "unsupported_capability", provider: name, capability: "reconcile" });
      expect(r.status).not.toBe("completed");
    });
  }
});

describe("harness registry resolves control adapters by provider", () => {
  test("opencode + daytona alias preserve the OpenCode harness contract", () => {
    expect(resolveHarness("opencode")?.provider).toBe(opencodeHarness.provider);
    expect(resolveHarness("daytona")?.provider).toBe(opencodeHarness.provider);
    expect(resolveHarness("opencode")?.capabilities()).toEqual(opencodeHarness.capabilities());
  });
  test("claude/claude-sdk/codex preserve the legacy provider capabilities", () => {
    expect(resolveHarness("claude")?.provider).toBe(claudeHarness.provider);
    expect(resolveHarness("claude-sdk")?.provider).toBe(claudeHarness.provider);
    expect(resolveHarness("codex")?.provider).toBe(codexHarness.provider);
    expect(resolveHarness("pi")?.provider).toBe("pi");
    expect(resolveHarness("claude")?.capabilities()).toEqual(claudeHarness.capabilities());
    expect(resolveHarness("codex")?.capabilities()).toEqual(codexHarness.capabilities());
  });

  test("Pi recovery route is registered but does not claim restart reconcile", async () => {
    const harness = resolveHarness("pi");
    expect(harness?.capabilities().authoritativeHistory).toBe(false);
    await expect(harness?.reconcile({
      provider: "pi",
      sessionId: "/sessions/pi.jsonl",
      sandboxId: "box",
    })).resolves.toMatchObject({ status: "unsupported_capability", capability: "reconcile" });
  });
  test("an unregistered provider resolves to undefined (e.g. mock/legacy acp)", () => {
    expect(resolveHarness("mock")).toBeUndefined();
    expect(resolveHarness("acp")).toBeUndefined();
  });
  test("every registered harness satisfies the HarnessAdapter shape", () => {
    for (const provider of ["claude", "claude-sdk", "codex", "daytona", "opencode"]) {
      const h = resolveHarness(provider);
      expect(h).toBeDefined();
      if (!h) continue;
      expect(typeof h.provider).toBe("string");
      expect(typeof h.capabilities).toBe("function");
      expect(typeof h.cancel).toBe("function");
      expect(typeof h.reconcile).toBe("function");
    }
  });
});
