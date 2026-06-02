import { describe, expect, test } from "bun:test";
import {
  bridgeChildUsage,
  NativeBridgeDeltaAccumulator,
  NativeBridgeSequencer,
  NATIVE_BRIDGE_PROTOCOL_VERSION,
} from "../src/bridge";

describe("native bridge contract", () => {
  test("orders every frame monotonically within one session", () => {
    let now = 100;
    const frames = new NativeBridgeSequencer("pi-session", () => ++now);
    const started = frames.frame({ kind: "turn.started" });
    const delta = frames.frame({ kind: "message.delta", messageId: "m1", text: "hi" });
    const completed = frames.frame({ kind: "turn.completed" });

    expect(frames).toBeDefined();
    expect([started.seq, delta.seq, completed.seq]).toEqual([1, 2, 3]);
    expect(started.protocolVersion).toBe(NATIVE_BRIDGE_PROTOCOL_VERSION);
    expect(completed.ts).toBeGreaterThan(delta.ts);
  });

  test("keeps only finite numeric child-usage counters", () => {
    expect(bridgeChildUsage({ input: 12, output: 3, model: "pi", bad: Number.NaN })).toEqual({
      input: 12,
      output: 3,
    });
  });

  test("stores incremental native deltas as one cumulative durable revision", () => {
    const accumulator = new NativeBridgeDeltaAccumulator();
    expect(accumulator.durable({
      kind: "reasoning.delta",
      messageId: "message",
      text: "Let ",
    })).toMatchObject({ text: "Let " });
    expect(accumulator.durable({
      kind: "reasoning.delta",
      messageId: "message",
      text: "me think",
    })).toMatchObject({ text: "Let me think" });
  });
});
