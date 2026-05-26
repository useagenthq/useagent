import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { HarnessAdapter } from "./types";
import { routeRuntimeHarness, runtimeHarness } from "./runtime-harness";
import {
  buildRuntimeTurnInterruptCommand,
  isRuntimeThreadSessionId,
} from "./runtime-orchestration";

const LEGACY_CAPABILITIES = {
  resume: true,
  cancel: true,
  streaming: "parts" as const,
  authoritativeHistory: false,
  childSessions: false,
  approvals: false,
  questions: false,
  reasoning: false,
  todos: false,
  patches: false,
  usage: false,
};

describe("T3 control harness", () => {
  test("builds the native T3 interrupt command", () => {
    const command = buildRuntimeTurnInterruptCommand(
      "skynet-thread-thread-1",
      "turn-1",
      "2026-08-12T00:00:00.000Z",
    );
    expect(command.type).toBe("thread.turn.interrupt");
    expect(command.threadId).toBe("skynet-thread-thread-1");
    expect(command.turnId).toBe("turn-1");
    expect(command.createdAt).toBe("2026-08-12T00:00:00.000Z");
  });

  test("recognizes only Skynet-owned native T3 sessions", () => {
    expect(isRuntimeThreadSessionId("skynet-thread-thread-1")).toBe(true);
    expect(isRuntimeThreadSessionId("ses_opencode")).toBe(false);
  });

  test("cancels the projected turn by its native turn id", () => {
    const source = readFileSync(new URL("./runtime-harness.ts", import.meta.url), "utf8");
    expect(source).toContain("snapshot.thread.latestTurn?.turnId");
  });

  test("preserves legacy control for non-T3 session ids", async () => {
    let usedLegacy = false;
    const legacy: HarnessAdapter = {
      provider: "codex",
      capabilities: () => ({ ...LEGACY_CAPABILITIES }),
      cancel: async () => {
        usedLegacy = true;
        return { status: "ok" };
      },
      reconcile: async () => {
        usedLegacy = true;
        return { status: "no_change" };
      },
    };
    const routed = routeRuntimeHarness(legacy);
    await routed.cancel(
      { provider: "codex", sessionId: "legacy-session", sandboxId: "sbx" },
      "stop",
    );
    expect(usedLegacy).toBe(true);
  });

  test("reports T3 capabilities for a native T3 session handle", () => {
    const legacy: HarnessAdapter = {
      provider: "codex",
      capabilities: () => ({ ...LEGACY_CAPABILITIES }),
      cancel: async () => ({ status: "ok" }),
      reconcile: async () => ({ status: "no_change" }),
    };

    const routed = routeRuntimeHarness(legacy);
    const runtimeCaps = routed.capabilities({
      provider: "codex",
      sessionId: "skynet-thread-thread-1",
      sandboxId: "sbx",
    });
    expect(runtimeCaps).toEqual(runtimeHarness.capabilities());
    expect(runtimeCaps.authoritativeHistory).toBe(true);
    expect(runtimeCaps.childSessions).toBe(true);
    expect(runtimeCaps.approvals).toBe(true);
    expect(runtimeCaps.questions).toBe(true);
    expect(runtimeCaps.reasoning).toBe(true);
    expect(runtimeCaps.patches).toBe(true);
  });

  test("keeps legacy capabilities when no T3 session handle is available", () => {
    const legacy: HarnessAdapter = {
      provider: "codex",
      capabilities: () => ({ ...LEGACY_CAPABILITIES }),
      cancel: async () => ({ status: "ok" }),
      reconcile: async () => ({ status: "no_change" }),
    };

    const routed = routeRuntimeHarness(legacy);
    expect(routed.capabilities()).toEqual(LEGACY_CAPABILITIES);
    expect(
      routed.capabilities({
        provider: "codex",
        sessionId: "legacy-session",
        sandboxId: "sbx",
      }),
    ).toEqual(LEGACY_CAPABILITIES);
  });
});
