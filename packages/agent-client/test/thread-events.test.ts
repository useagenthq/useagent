// decodeFrame hardening: a non-object JSON payload (null/number/string/bool/array) must
// never be dereferenced (it would throw and tear down the connection), and
// canonical-complete must validate the frame thread the same way canonical events do.

import { describe, expect, test } from "bun:test";
import { decodeFrame, validateCanonicalComplete } from "../src/thread-events";

const canonical = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1, eventId: "e1", kind: "message.delta", messageId: "m", text: "hi",
  runId: "r1", threadId: "t1", seq: 1, ts: 1, deliverySeq: 1, revision: 0,
  identity: { provider: "opencode" }, ...over,
});

describe("decodeFrame: non-object payloads are malformed, never dereferenced", () => {
  for (const [label, data] of [
    ["null", "null"],
    ["number", "5"],
    ["string", "\"hello\""],
    ["boolean", "true"],
    ["array", "[1,2,3]"],
    ["bad json", "{not json"],
  ] as const) {
    test(`canonical + ${label} -> malformed (no throw)`, () => {
      expect(() => decodeFrame("canonical", data)).not.toThrow();
      expect(decodeFrame("canonical", data)).toEqual({ kind: "malformed", type: "canonical" });
    });
    test(`snapshot + ${label} -> malformed (no throw)`, () => {
      expect(() => decodeFrame("snapshot", data)).not.toThrow();
      expect(decodeFrame("snapshot", data)).toEqual({ kind: "malformed", type: "snapshot" });
    });
    test(`canonical-complete + ${label} -> malformed (no throw)`, () => {
      expect(() => decodeFrame("canonical-complete", data)).not.toThrow();
      expect(decodeFrame("canonical-complete", data)).toEqual({ kind: "malformed", type: "canonical-complete" });
    });
  }
});

describe("decodeFrame: canonical-complete thread validation", () => {
  test("valid complete (no threadId on the record) -> ok", () => {
    expect(decodeFrame("canonical-complete", JSON.stringify({ threadId: "t1", complete: { runId: "r1" } })))
      .toEqual({ kind: "canonical-complete", complete: { runId: "r1" } });
  });
  test("complete carrying a MATCHING threadId -> ok", () => {
    expect(decodeFrame("canonical-complete", JSON.stringify({ threadId: "t1", complete: { runId: "r1", threadId: "t1" } })))
      .toEqual({ kind: "canonical-complete", complete: { runId: "r1" } });
  });
  test("complete carrying a MISMATCHED threadId -> malformed (never cross-thread)", () => {
    expect(decodeFrame("canonical-complete", JSON.stringify({ threadId: "t1", complete: { runId: "r1", threadId: "OTHER" } })))
      .toEqual({ kind: "malformed", type: "canonical-complete" });
  });
  test("complete missing runId -> malformed", () => {
    expect(decodeFrame("canonical-complete", JSON.stringify({ threadId: "t1", complete: {} })))
      .toEqual({ kind: "malformed", type: "canonical-complete" });
  });
  test("validateCanonicalComplete is exported + total on junk input", () => {
    expect(validateCanonicalComplete(null)).toBeNull();
    expect(validateCanonicalComplete(5)).toBeNull();
    expect(validateCanonicalComplete({ runId: "r1" })).toEqual({ runId: "r1" });
  });
});

describe("decodeFrame: valid frames still decode", () => {
  test("valid canonical -> canonical", () => {
    const r = decodeFrame("canonical", JSON.stringify({ threadId: "t1", event: canonical() }));
    expect(r.kind).toBe("canonical");
  });
  test("valid snapshot -> raw", () => {
    expect(decodeFrame("snapshot", JSON.stringify({ runs: [] }))).toMatchObject({ kind: "raw", type: "snapshot" });
  });
  test("unknown future frame -> unknown (surfaced, not fatal)", () => {
    expect(decodeFrame("some-future-frame", JSON.stringify({ x: 1 }))).toMatchObject({ kind: "unknown", type: "some-future-frame" });
  });

  test("unknown provider-native event type remains byte-for-byte structured data", () => {
    const frame = {
      schemaVersion: 1,
      eventId: "pi-experimental-1",
      seq: 9,
      provider: "pi",
      eventType: "pi.experimental.capability",
      native: {
        sessionId: "pi-session",
        parentSessionId: null,
        messageId: "pi-message",
        partId: "pi-part",
        callId: "pi-call",
      },
      payload: {
        capability: "future-tool",
        detail: { version: 2, enabled: true },
      },
    };

    expect(decodeFrame("native", JSON.stringify(frame))).toEqual({
      kind: "raw",
      type: "native",
      payload: frame,
    });
  });
});
