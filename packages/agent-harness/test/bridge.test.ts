import { describe, expect, test } from "bun:test";
import {
  bridgeChildUsage,
  NativeBridgeDeltaAccumulator,
  NATIVE_BRIDGE_DURABLE_TEXT_BYTES,
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
    })[0]).toMatchObject({ text: "Let " });
    expect(accumulator.durable({
      kind: "reasoning.delta",
      messageId: "message",
      text: "me think",
    })[0]).toMatchObject({ text: "Let me think" });
  });

  test("segments long streams without exceeding durable JSON capacity or losing text", () => {
    const accumulator = new NativeBridgeDeltaAccumulator();
    accumulator.durable({ kind: "message.delta", messageId: "long-message", text: "discarded draft" });
    const text = "\u0000".repeat(NATIVE_BRIDGE_DURABLE_TEXT_BYTES * 10);
    const segments = accumulator.durable({
      kind: "message.authoritative",
      messageId: "long-message",
      text,
    });
    expect(segments.length).toBeGreaterThan(1);
    expect(segments.map((body) => body.kind === "message.delta" ? body.text : "").join(""))
      .toBe(text);
    for (const body of segments) {
      expect(new TextEncoder().encode(JSON.stringify(body)).byteLength).toBeLessThan(32_768);
    }
  });

  test("authoritative empty text replaces a multi-segment draft without stale replay", () => {
    const accumulator = new NativeBridgeDeltaAccumulator();
    accumulator.durable({
      kind: "message.delta",
      messageId: "message",
      text: "x".repeat(NATIVE_BRIDGE_DURABLE_TEXT_BYTES * 2 + 1),
    });

    expect(accumulator.durable({
      kind: "message.authoritative",
      messageId: "message",
      text: "",
    })).toEqual([
      { kind: "message.delta", messageId: "message", text: "", segment: 0, authoritative: true },
      { kind: "message.delta", messageId: "message", text: "", segment: 1, authoritative: true },
      { kind: "message.delta", messageId: "message", text: "", segment: 2, authoritative: true },
    ]);
  });

  test("authoritative shrink tombstones only segments beyond the replacement", () => {
    const accumulator = new NativeBridgeDeltaAccumulator();
    accumulator.durable({
      kind: "message.delta",
      messageId: "message",
      text: "x".repeat(NATIVE_BRIDGE_DURABLE_TEXT_BYTES * 2 + 1),
    });

    expect(accumulator.durable({
      kind: "message.authoritative",
      messageId: "message",
      text: "replacement",
    })).toEqual([
      {
        kind: "message.delta",
        messageId: "message",
        text: "replacement",
        segment: 0,
        authoritative: true,
      },
      { kind: "message.delta", messageId: "message", text: "", segment: 1, authoritative: true },
      { kind: "message.delta", messageId: "message", text: "", segment: 2, authoritative: true },
    ]);
  });
});
