import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { HarnessAdapter } from "./types";
import { routeT3Harness, t3Harness } from "./t3-harness";
import {
  buildT3TurnInterruptCommand,
  isT3ThreadSessionId,
} from "./t3-orchestration";

describe("T3 control harness", () => {
  test("builds the native T3 interrupt command", () => {
    const command = buildT3TurnInterruptCommand(
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
    expect(isT3ThreadSessionId("skynet-thread-thread-1")).toBe(true);
    expect(isT3ThreadSessionId("ses_opencode")).toBe(false);
  });

  test("cancels the projected turn by its native turn id", () => {
    const source = readFileSync(new URL("./t3-harness.ts", import.meta.url), "utf8");
    expect(source).toContain("snapshot.thread.latestTurn?.turnId");
  });

  test("preserves legacy control for non-T3 session ids", async () => {
    let usedLegacy = false;
    const legacy: HarnessAdapter = {
      provider: "codex",
      capabilities: () => t3Harness.capabilities(),
      cancel: async () => {
        usedLegacy = true;
        return { status: "ok" };
      },
      reconcile: async () => {
        usedLegacy = true;
        return { status: "no_change" };
      },
    };
    const routed = routeT3Harness(legacy);
    await routed.cancel(
      { provider: "codex", sessionId: "legacy-session", sandboxId: "sbx" },
      "stop",
    );
    expect(usedLegacy).toBe(true);
  });
});
