import { describe, expect, test } from "bun:test";
import { nativeBridgeSettlement, runNativeBridgeTurn } from "./native-bridge-runtime";

describe("native bridge turn settlement", () => {
  test("provider failure cannot finalize as success", () => {
    expect(nativeBridgeSettlement({ kind: "turn.failed", error: "upstream failed" })).toEqual({
      status: "failed",
      error: "upstream failed",
    });
  });

  test("an already-aborted run never dispatches", async () => {
    const controller = new AbortController();
    controller.abort();
    let dispatched = false;
    await expect(runNativeBridgeTurn({
      ctx: {
        runId: "run",
        threadId: "thread",
        signal: controller.signal,
      } as never,
      driver: {
        steer: async () => {
          dispatched = true;
          return { status: "ok" };
        },
        cancel: async () => ({ status: "ok" }),
      } as never,
      session: { nativeSessionId: "session" } as never,
      bridge: { sessionFile: "/sessions/pi.jsonl", subscribe: () => () => {} },
      prompt: "do not dispatch",
      mapFrame: () => [],
      redact: (value) => value,
    })).rejects.toThrow();
    expect(dispatched).toBe(false);
  });
});
