// Phase 2: the composer's "/" catalog is SESSION-SCOPED from the DURABLE canonical stream, so a
// historical or other-session `commands.updated` can never mask the active session, and a
// restarted/new session that has not re-advertised falls back to the priming fetch instead of
// showing stale commands. `resolveCommandCatalog` folds the durable catalog + fetch into one
// honest state (loading / unavailable / error / ready[+stale]).
import { describe, expect, test } from "bun:test";
import { resolveCommandCatalog, selectSessionCommands, type StoredCanonicalEvent } from "./canonical-timeline";

function cmds(over: {
  runId: string;
  deliverySeq: number;
  sessionId: string;
  catalog: readonly { name: string; description?: string | null; input?: string | null }[];
}): StoredCanonicalEvent {
  return {
    schemaVersion: 1,
    kind: "commands.updated",
    eventId: `${over.runId}:${over.sessionId}:commands`,
    runId: over.runId,
    threadId: "t",
    seq: 0,
    deliverySeq: over.deliverySeq,
    revision: 0,
    identity: { nativeSessionId: over.sessionId },
    commands: over.catalog.map((c) => c.name),
    catalog: over.catalog,
  } as StoredCanonicalEvent;
}
const other = (runId: string, deliverySeq: number): StoredCanonicalEvent =>
  ({ schemaVersion: 1, kind: "message.delta", eventId: `${runId}:d`, runId, threadId: "t", seq: 0, deliverySeq, revision: 0 } as StoredCanonicalEvent);

describe("selectSessionCommands (session-scoped durable catalog)", () => {
  test("null sessionId -> null; a session that never advertised -> null (falls back to fetch)", () => {
    expect(selectSessionCommands([{ canonical: [cmds({ runId: "r1", deliverySeq: 1, sessionId: "s1", catalog: [{ name: "a" }] })] }], null)).toBeNull();
    expect(selectSessionCommands([{ canonical: [other("r1", 1)] }], "s1")).toBeNull();
  });

  test("returns the CURRENT session's catalog, ignoring other-session snapshots", () => {
    const runs = [
      { canonical: [cmds({ runId: "r1", deliverySeq: 9, sessionId: "OLD", catalog: [{ name: "stale" }] })] }, // higher seq, WRONG session
      { canonical: [cmds({ runId: "r2", deliverySeq: 3, sessionId: "CUR", catalog: [{ name: "review", input: "[files]" }] })] },
    ];
    expect(selectSessionCommands(runs, "CUR")).toEqual([{ name: "review", description: null, input: "[files]" }]);
  });

  test("a NEW session with no catalog yet is NOT masked by the prior session's catalog (-> null)", () => {
    const runs = [{ canonical: [cmds({ runId: "r1", deliverySeq: 5, sessionId: "OLD", catalog: [{ name: "old" }] })] }];
    expect(selectSessionCommands(runs, "NEW")).toBeNull();
  });

  test("latest snapshot for the SAME session wins (by deliverySeq)", () => {
    const runs = [
      { canonical: [cmds({ runId: "r1", deliverySeq: 2, sessionId: "s", catalog: [{ name: "a" }] })] },
      { canonical: [cmds({ runId: "r1", deliverySeq: 7, sessionId: "s", catalog: [{ name: "b" }] })] },
    ];
    expect(selectSessionCommands(runs, "s")).toEqual([{ name: "b", description: null, input: null }]);
  });

  test("an EMPTY replacement for the current session yields [] (advertises none), NOT null", () => {
    const runs = [{ canonical: [cmds({ runId: "r1", deliverySeq: 2, sessionId: "s", catalog: [] })] }];
    expect(selectSessionCommands(runs, "s")).toEqual([]);
  });
});

describe("resolveCommandCatalog (one honest command-picker state)", () => {
  const loading = { phase: "loading" as const, commands: [] };
  const err = { phase: "error" as const, commands: [] };
  const done = (commands: { name: string }[]) => ({ phase: "done" as const, commands });

  test("durable non-empty -> ready; durable empty -> unavailable (the live session wins)", () => {
    expect(resolveCommandCatalog([{ name: "a" }], loading, "claude")).toEqual({ status: "ready", commands: [{ name: "a" }], source: "claude" });
    expect(resolveCommandCatalog([], done([{ name: "cached" }]), "claude")).toEqual({ status: "unavailable", source: "claude" });
  });

  test("no durable catalog -> fetch drives the state (loading / ready+stale / unavailable / error)", () => {
    expect(resolveCommandCatalog(null, loading, "codex")).toEqual({ status: "loading" });
    expect(resolveCommandCatalog(null, done([{ name: "x" }]), "codex")).toEqual({ status: "ready", commands: [{ name: "x" }], source: "codex", stale: true });
    expect(resolveCommandCatalog(null, done([]), "codex")).toEqual({ status: "unavailable", source: "codex" });
    expect(resolveCommandCatalog(null, err, "codex")).toEqual({ status: "error" });
  });
});
