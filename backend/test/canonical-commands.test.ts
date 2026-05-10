import { describe, expect, test } from "bun:test";
import type { CanonicalAgentEvent } from "../src/engines/canonical";
import { appendCommandsCatalogEvent } from "../src/runs/canonicalization-outbox";
import { cacheSessionCommands } from "../src/runs/command-catalog";
import "./helpers"; // migrate + seed

// Review: a session's provider command catalog is emitted into the run's DURABLE canonical
// output as a session-identified commands.updated, sourced from the PER-SESSION snapshot (never
// the org-wide cache) so an empty replacement is honored and it survives per-run row replacement.
const uid = () => crypto.randomUUID();

describe("commands.updated on the durable canonical stream (per-session, review)", () => {
  test("an ACP run with a non-empty session snapshot appends a session-identified commands.updated", async () => {
    const thread = uid();
    const run = uid();
    await cacheSessionCommands(thread, [
      { name: "review", description: "Review the diff", input: "[files]" },
      { name: "status" },
    ]);
    const events: CanonicalAgentEvent[] = [];
    await appendCommandsCatalogEvent(events, run, thread, "claude", "ses_abc");
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e?.kind).toBe("commands.updated");
    expect(e?.eventId).toBe(`${run}:commands`);
    expect(e?.threadId).toBe(thread);
    expect(e?.identity.provider).toBe("claude");
    expect(e?.identity.nativeSessionId).toBe("ses_abc"); // session-identified
    if (e?.kind === "commands.updated") {
      expect(e.commands).toEqual(["review", "status"]);
      expect(e.catalog).toEqual([{ name: "review", description: "Review the diff", input: "[files]" }, { name: "status" }]);
    }
  });

  test("an EMPTY session snapshot emits an EMPTY commands.updated (replacement is honored, not dropped)", async () => {
    const thread = uid();
    await cacheSessionCommands(thread, [{ name: "gone" }]); // had commands...
    await cacheSessionCommands(thread, []); // ...then the provider cleared them (empty replacement)
    const events: CanonicalAgentEvent[] = [];
    await appendCommandsCatalogEvent(events, uid(), thread, "codex", null);
    expect(events).toHaveLength(1);
    if (events[0]?.kind === "commands.updated") {
      expect(events[0].commands).toEqual([]);
      expect(events[0].catalog).toEqual([]);
    }
  });

  test("a session that NEVER advertised commands emits NOTHING (absence != empty)", async () => {
    const events: CanonicalAgentEvent[] = [];
    await appendCommandsCatalogEvent(events, uid(), uid(), "claude", null);
    expect(events).toHaveLength(0);
  });

  test("a non-ACP engine (opencode) never emits this event (its live catalog is served separately)", async () => {
    const thread = uid();
    await cacheSessionCommands(thread, [{ name: "x" }]);
    const events: CanonicalAgentEvent[] = [];
    await appendCommandsCatalogEvent(events, uid(), thread, "opencode", null);
    expect(events).toHaveLength(0);
  });

  test("the appended event orders AFTER the translated timeline events", async () => {
    const thread = uid();
    await cacheSessionCommands(thread, [{ name: "c" }]);
    const events = [{ seq: 0 }, { seq: 1 }] as unknown as CanonicalAgentEvent[];
    await appendCommandsCatalogEvent(events, uid(), thread, "claude", null);
    expect(events[2]?.seq).toBe(2); // seq = prior events.length -> ordered last
  });
});
