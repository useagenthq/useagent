// Capability wiring: the composer's "/" catalog is read from the DURABLE canonical stream's
// per-session `commands.updated` (not the org-wide cache), so a reconnect/replay reconstructs
// the SAME catalog. Latest snapshot across the thread wins (by deliverySeq); an empty
// replacement yields []; a thread that never advertised commands yields null (caller then
// falls back to the live fetch).

import { describe, expect, test } from "bun:test";
import { selectThreadCommands, type StoredCanonicalEvent } from "./canonical-timeline";

function cmds(over: {
  runId: string;
  deliverySeq: number;
  catalog: readonly { name: string; description?: string | null; input?: string | null }[];
}): StoredCanonicalEvent {
  return {
    schemaVersion: 1,
    kind: "commands.updated",
    eventId: `${over.runId}:commands`,
    runId: over.runId,
    threadId: "t",
    seq: 0,
    deliverySeq: over.deliverySeq,
    revision: 0,
    commands: over.catalog.map((c) => c.name),
    catalog: over.catalog,
  } as StoredCanonicalEvent;
}
const other = (runId: string, deliverySeq: number): StoredCanonicalEvent =>
  ({ schemaVersion: 1, kind: "message.delta", eventId: `${runId}:d`, runId, threadId: "t", seq: 0, deliverySeq, revision: 0 } as StoredCanonicalEvent);

describe("selectThreadCommands (durable per-session catalog)", () => {
  test("a thread that never advertised commands -> null (caller falls back to the live fetch)", () => {
    expect(selectThreadCommands([{ canonical: [other("r1", 1)] }])).toBeNull();
    expect(selectThreadCommands([])).toBeNull();
  });

  test("returns the catalog (name + description + input) from a single commands.updated", () => {
    const runs = [{ canonical: [cmds({ runId: "r1", deliverySeq: 3, catalog: [{ name: "review", description: "Review the diff", input: "[files]" }] })] }];
    expect(selectThreadCommands(runs)).toEqual([{ name: "review", description: "Review the diff", input: "[files]" }]);
  });

  test("LATEST across the whole thread wins, by deliverySeq (a later run's snapshot replaces an earlier one)", () => {
    const runs = [
      { canonical: [cmds({ runId: "r1", deliverySeq: 2, catalog: [{ name: "old" }] })] },
      { canonical: [other("r2", 5), cmds({ runId: "r2", deliverySeq: 9, catalog: [{ name: "new" }] })] },
    ];
    expect(selectThreadCommands(runs)).toEqual([{ name: "new", description: null, input: null }]);
  });

  test("an EMPTY replacement yields [] (honored, not the prior catalog) and is NOT null", () => {
    const runs = [
      { canonical: [cmds({ runId: "r1", deliverySeq: 2, catalog: [{ name: "gone" }] })] },
      { canonical: [cmds({ runId: "r2", deliverySeq: 4, catalog: [] })] },
    ];
    const out = selectThreadCommands(runs);
    expect(out).not.toBeNull();
    expect(out).toEqual([]);
  });

  test("missing description/input default to null (stable shape for the popover)", () => {
    const runs = [{ canonical: [cmds({ runId: "r1", deliverySeq: 1, catalog: [{ name: "status" }] })] }];
    expect(selectThreadCommands(runs)).toEqual([{ name: "status", description: null, input: null }]);
  });
});
