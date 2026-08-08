// Review: the client reads the native command catalog from the DURABLE canonical thread stream
// (commands.updated), so a reconnect/replay reconstructs the SAME catalog. Latest snapshot wins;
// an empty replacement yields [].
import { describe, expect, test } from "bun:test";
import { selectCommands } from "../src/selectors";
import { createCanonicalThreadStore } from "../src/thread-store";
import type { CanonicalThreadEvent } from "../src/thread-events";

let seq = 0;
function ev(over: Record<string, unknown>): CanonicalThreadEvent {
  const deliverySeq = (over.deliverySeq as number) ?? ++seq;
  return {
    schemaVersion: 1,
    eventId: (over.eventId as string) ?? `evt_${deliverySeq}`,
    seq: deliverySeq,
    runId: "r",
    threadId: "t",
    ts: deliverySeq,
    identity: { provider: "claude" },
    revision: (over.revision as number) ?? 0,
    deliverySeq,
    ...over,
  } as CanonicalThreadEvent;
}

describe("selectCommands (native catalog from the durable stream)", () => {
  test("returns the LATEST commands.updated catalog", () => {
    const s = createCanonicalThreadStore();
    s.ingest(ev({ eventId: "c1", kind: "commands.updated", commands: ["a"], catalog: [{ name: "a" }], deliverySeq: 1 }));
    s.ingest(ev({ eventId: "c2", kind: "commands.updated", commands: ["b", "c"], catalog: [{ name: "b", input: "<x>" }, { name: "c" }], deliverySeq: 2 }));
    expect(selectCommands(s.getSnapshot())).toEqual([{ name: "b", input: "<x>" }, { name: "c" }]);
  });

  test("an empty replacement yields [] (honored, not the prior catalog)", () => {
    const s = createCanonicalThreadStore();
    s.ingest(ev({ eventId: "c1", kind: "commands.updated", commands: ["a"], catalog: [{ name: "a" }], deliverySeq: 1 }));
    s.ingest(ev({ eventId: "c2", kind: "commands.updated", commands: [], catalog: [], deliverySeq: 2 }));
    expect(selectCommands(s.getSnapshot())).toEqual([]);
  });

  test("no commands.updated -> [] (a provider that advertises none)", () => {
    const s = createCanonicalThreadStore();
    s.ingest(ev({ eventId: "x", kind: "turn.started", deliverySeq: 1 }));
    expect(selectCommands(s.getSnapshot())).toEqual([]);
  });

  test("replay (replace) reconstructs the SAME catalog", () => {
    const s = createCanonicalThreadStore();
    const rows = [ev({ eventId: "c", kind: "commands.updated", commands: ["z"], catalog: [{ name: "z", description: "d" }], deliverySeq: 7 })];
    s.reconcile(rows);
    expect(selectCommands(s.getSnapshot())).toEqual([{ name: "z", description: "d" }]);
  });
});
