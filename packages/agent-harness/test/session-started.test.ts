import { describe, expect, test } from "bun:test";
import {
  SESSION_STARTED_EVENT_TYPE,
  normalizeNegotiatedCapabilities,
  parseSessionStartedFrame,
} from "../src/canonical";
import { translateOpenCode, type OpenCodeFrame } from "../src/opencode-canonical";

// Phase 6: a real session's negotiated capabilities are captured as a durable `session.started`
// provider event and translated to the ONE canonical session.started event the UI gates on.
const CTX = { runId: "r", threadId: "t", engine: "claude" };
function frame(over: { sessionId: string; provider: string; capabilities: unknown; source?: string }): OpenCodeFrame {
  return {
    eventId: `${over.sessionId}:session`, seq: 0, provider: over.provider, eventType: SESSION_STARTED_EVENT_TYPE,
    native: { sessionId: over.sessionId, parentSessionId: null, messageId: null, partId: null, callId: null },
    payload: { source: over.source ?? over.provider, capabilities: over.capabilities },
  };
}

describe("normalizeNegotiatedCapabilities (the ONE capability model, missing => false)", () => {
  test("keeps known booleans, defaults every missing/non-bool key to false", () => {
    const caps = normalizeNegotiatedCapabilities({ commands: true, desktop: true, nativeEmbed: "yes", bogus: true });
    expect(caps.commands).toBe(true);
    expect(caps.desktop).toBe(true);
    expect(caps.nativeEmbed).toBe(false); // non-bool -> false
    expect(caps.stop).toBe(false); // missing -> false
    expect((caps as unknown as Record<string, unknown>).bogus).toBeUndefined(); // unknown keys dropped
  });
});

describe("parseSessionStartedFrame", () => {
  test("parses capabilities + source; null when no capabilities object", () => {
    expect(parseSessionStartedFrame({ source: "codex", capabilities: { stop: true } })?.capabilities.stop).toBe(true);
    expect(parseSessionStartedFrame({ source: "codex", capabilities: { stop: true } })?.source).toBe("codex");
    expect(parseSessionStartedFrame({ source: "codex" })).toBeNull();
    expect(parseSessionStartedFrame(null)).toBeNull();
  });
});

describe("translateOpenCode: session.started frame -> session-identified canonical session.started", () => {
  const events = (frames: OpenCodeFrame[]) => translateOpenCode(frames, CTX, []).events.filter((e) => e.kind === "session.started");

  test("emits session.started with the capability map, source, and native session identity", () => {
    const [e] = events([frame({ sessionId: "s1", provider: "claude", source: "claude", capabilities: { commands: true, stop: true, desktop: false, nativeEmbed: false } })]);
    expect(e?.kind).toBe("session.started");
    expect(e?.identity.nativeSessionId).toBe("s1");
    if (e?.kind === "session.started") {
      expect(e.source).toBe("claude");
      expect(e.capabilities.commands).toBe(true);
      expect(e.capabilities.stop).toBe(true);
      expect(e.capabilities.desktop).toBe(false);
      expect(e.capabilities.nativeEmbed).toBe(false);
    }
  });

  test("an unparseable session.started frame emits nothing and does NOT warn", () => {
    const { events: all } = translateOpenCode(
      [{ eventId: "x", seq: 0, provider: "claude", eventType: SESSION_STARTED_EVENT_TYPE, native: { sessionId: "s1", parentSessionId: null, messageId: null, partId: null, callId: null }, payload: { source: "claude" } }],
      CTX,
      [],
    );
    expect(all.filter((e) => e.kind === "session.started")).toHaveLength(0);
    expect(all.filter((e) => e.kind === "harness.warning")).toHaveLength(0);
  });

  test("a plain OpenCode run emits no session.started (no such frame)", () => {
    expect(events([{ eventId: "x", seq: 0, provider: "opencode", eventType: "part.text", native: { sessionId: "s", parentSessionId: null, messageId: "m", partId: "p", callId: null }, payload: { text: "hi" } }])).toHaveLength(0);
  });
});
