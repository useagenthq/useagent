import { describe, expect, test } from "bun:test";
import { deriveChildrenView } from "./canonical-children";
import { createCanonicalThreadStore } from "@useagent/agent-client";
import type { StoredCanonicalEvent } from "./canonical-timeline";
import {
  deriveChildrenViewWithExecutionSummary,
  deriveChildrenViewFromExecutionSummary,
  parseExecutionSummaryRolloutMode,
  type ExecutionSummaryDiagnostic,
} from "./execution-summary-rollout";

function stored(
  eventId: string,
  seq: number,
  body: Record<string, unknown>,
  revision = 0,
): StoredCanonicalEvent {
  return {
    schemaVersion: 1,
    eventId,
    runId: "run-1",
    threadId: "thread-1",
    seq,
    ts: 1_000 + seq,
    deliverySeq: seq,
    revision,
    identity: {
      provider: "test-provider",
      nativeSessionId: "parent-session",
      nativeSeq: seq,
    },
    ...body,
  } as StoredCanonicalEvent;
}

function revisedIdentityEvents(): StoredCanonicalEvent[] {
  return [
    stored("spawn", 1, {
      kind: "child.started",
      childId: "child-a",
      launchToolCallId: "launch-a",
      title: "Original child",
    }),
    stored("tool-a", 2, {
      kind: "tool.started",
      toolCallId: "tool-a",
      name: "read_file",
      identity: {
        provider: "test-provider",
        nativeSessionId: "child-a",
        nativeSeq: 2,
      },
    }),
    stored(
      "spawn",
      3,
      {
        kind: "child.started",
        childId: "child-b",
        launchToolCallId: "launch-b",
        title: "Corrected child",
      },
      1,
    ),
  ];
}

describe("execution-summary off|shadow|read rollout seam", () => {
  test("parses only explicit shadow/read flags and defaults rollback to off", () => {
    expect(parseExecutionSummaryRolloutMode(undefined)).toBe("off");
    expect(parseExecutionSummaryRolloutMode("off")).toBe("off");
    expect(parseExecutionSummaryRolloutMode("invalid")).toBe("off");
    expect(parseExecutionSummaryRolloutMode("shadow")).toBe("shadow");
    expect(parseExecutionSummaryRolloutMode("read")).toBe("read");
  });

  test("off returns the exact legacy derivation and never evaluates diagnostics", () => {
    const events = [{ kind: "child.started", seq: 1, childId: "legacy-child" }];
    const diagnostics: ExecutionSummaryDiagnostic[] = [];
    const legacy = deriveChildrenView([], [], events);
    const off = deriveChildrenViewWithExecutionSummary([], [], events, {
      mode: "off",
      onDiagnostic: (value) => diagnostics.push(value),
    });
    expect(off).toEqual(legacy);
    expect(diagnostics).toEqual([]);
  });

  test("shadow detects a bounded mismatch but cannot affect the returned legacy view", () => {
    const events = revisedIdentityEvents();
    const diagnostics: ExecutionSummaryDiagnostic[] = [];
    const legacy = deriveChildrenView([], [], events);
    const shadow = deriveChildrenViewWithExecutionSummary([], [], events, {
      mode: "shadow",
      onDiagnostic: (value) => diagnostics.push(value),
    });

    expect(shadow).toEqual(legacy);
    expect(shadow.cards.map((card) => card.childSessionId)).toEqual(["child-a", "child-b"]);
    expect(diagnostics).toEqual([
      {
        code: "view-mismatch",
        legacyCards: 2,
        projectedCards: 1,
        legacyFingerprint: expect.stringMatching(/^[0-9a-f]{8}$/),
        projectedFingerprint: expect.stringMatching(/^[0-9a-f]{8}$/),
      },
    ]);
  });

  test("read activates the production projection after validation", () => {
    const read = deriveChildrenViewWithExecutionSummary([], [], revisedIdentityEvents(), {
      mode: "read",
    });
    expect(read.cards.map((card) => card.childSessionId)).toEqual(["child-b"]);
    expect(read.cards[0]).toMatchObject({
      id: "canonical-child-child-b",
      title: "Corrected child",
      aliases: ["launch-b", "child-b"],
    });
  });

  test("read safely falls back to legacy when projector input is incomplete", () => {
    const events = [{ kind: "child.started", seq: 1, childId: "legacy-child", title: "Legacy" }];
    const diagnostics: ExecutionSummaryDiagnostic[] = [];
    const legacy = deriveChildrenView([], [], events);
    const read = deriveChildrenViewWithExecutionSummary([], [], events, {
      mode: "read",
      onDiagnostic: (value) => diagnostics.push(value),
    });
    expect(read).toEqual(legacy);
    expect(diagnostics).toEqual([
      {
        code: "invalid-input",
        legacyCards: 1,
        projectedCards: null,
        legacyFingerprint: expect.stringMatching(/^[0-9a-f]{8}$/),
        projectedFingerprint: null,
      },
    ]);
  });

  test("read safely falls back when valid envelopes cross thread scope", () => {
    const [started, activity, revised] = revisedIdentityEvents();
    if (!started || !activity || !revised) throw new Error("expected revision fixtures");
    const crossThread = { ...revised, threadId: "thread-2", eventId: "thread-2-spawn" };
    const events = [started, activity, revised, crossThread];
    const diagnostics: ExecutionSummaryDiagnostic[] = [];
    const legacy = deriveChildrenView([], [], events);
    const read = deriveChildrenViewWithExecutionSummary([], [], events, {
      mode: "read",
      onDiagnostic: (value) => diagnostics.push(value),
    });
    expect(read).toEqual(legacy);
    expect(diagnostics[0]?.code).toBe("invalid-input");
  });

  test("shadow and read fall back instead of throwing on malformed projected fields", () => {
    const events = [
      stored("spawn", 1, { kind: "child.started", childId: "child-a" }),
      stored("tool", 2, {
        kind: "tool.started",
        toolCallId: "tool-a",
        name: 42,
        identity: {
          provider: "test-provider",
          nativeSessionId: "child-a",
          nativeSeq: 2,
        },
      }),
    ];
    const legacy = deriveChildrenView([], [], events);
    for (const mode of ["shadow", "read"] as const) {
      const diagnostics: ExecutionSummaryDiagnostic[] = [];
      expect(
        deriveChildrenViewWithExecutionSummary([], [], events, {
          mode,
          onDiagnostic: (value) => diagnostics.push(value),
        }),
      ).toEqual(legacy);
      expect(diagnostics[0]?.code).toBe("invalid-snapshot");
    }
  });

  test("read rejects array-shaped usage instead of activating malformed state", () => {
    const events = [
      stored("spawn", 1, {
        kind: "child.started",
        childId: "child-a",
        state: { status: "running", usage: [] },
      }),
    ];
    const diagnostics: ExecutionSummaryDiagnostic[] = [];
    const legacy = deriveChildrenView([], [], events);
    const read = deriveChildrenViewWithExecutionSummary([], [], events, {
      mode: "read",
      onDiagnostic: (value) => diagnostics.push(value),
    });
    expect(read).toEqual(legacy);
    expect(diagnostics[0]?.code).toBe("invalid-snapshot");
  });

  test("diagnostic failures cannot interfere with shadow rendering", () => {
    const events = revisedIdentityEvents();
    const legacy = deriveChildrenView([], [], events);
    expect(
      deriveChildrenViewWithExecutionSummary([], [], events, {
        mode: "shadow",
        onDiagnostic: () => {
          throw new Error("metrics unavailable");
        },
      }),
    ).toEqual(legacy);
  });

  test("read projection is provider-neutral", () => {
    const events = revisedIdentityEvents();
    const otherProvider = events.map((value) => ({
      ...value,
      identity: { ...value.identity, provider: "other-provider" },
    }));
    const first = deriveChildrenViewWithExecutionSummary([], [], events, { mode: "read" });
    const second = deriveChildrenViewWithExecutionSummary([], [], otherProvider, { mode: "read" });
    expect(second).toEqual(first);
  });

  test("read is idempotent across replayed duplicates and a newer revision", () => {
    const [started, activity, revised] = revisedIdentityEvents();
    if (!started || !activity || !revised) throw new Error("expected revision fixtures");
    const read = deriveChildrenViewWithExecutionSummary(
      [],
      [],
      [started, activity, started, revised, revised],
      { mode: "read" },
    );
    expect(read.cards.map((card) => card.childSessionId)).toEqual(["child-b"]);
    expect(read.fidelity.get("child-b")?.status).toBe("running");
  });

  test("stale lower revisions cannot change read presentation timestamps", () => {
    const started = stored("spawn", 1, {
      kind: "child.started",
      childId: "child-a",
      title: "Child",
    });
    const completed = stored(
      "complete",
      2,
      {
        kind: "child.completed",
        childId: "child-a",
        status: "ok",
        result: "current",
      },
      1,
    );
    const stale = stored(
      "complete",
      999,
      {
        kind: "child.completed",
        childId: "child-a",
        status: "error",
        result: "stale",
      },
      0,
    );
    const expected = deriveChildrenViewWithExecutionSummary([], [], [started, completed], {
      mode: "read",
    });
    const replayed = deriveChildrenViewWithExecutionSummary([], [], [started, completed, stale], {
      mode: "read",
    });
    expect(replayed).toEqual(expected);
    expect(replayed.cards[0]?.lastActivityAt).toBe(1_002);
    expect(replayed.fidelity.get("child-a")?.resultText).toBe("current");
  });

  test("production reads a stable store-owned snapshot without replaying history", () => {
    const events = revisedIdentityEvents();
    const store = createCanonicalThreadStore({ threadId: "thread-1" });
    for (const event of events) store.ingest(event as never);
    const snapshot = store.getExecutionSummary();
    const before = store.executionSummaryRetention();

    for (let index = 0; index < 20; index++) {
      const read = deriveChildrenViewFromExecutionSummary([], [], events, snapshot, {
        mode: "read",
      });
      expect(read.cards.map((card) => card.childSessionId)).toEqual(["child-b"]);
    }
    expect(store.getExecutionSummary()).toBe(snapshot);
    expect(store.executionSummaryRetention()).toEqual(before);
  });

  test("production off/shadow never render the supplied projection", () => {
    const events = revisedIdentityEvents();
    const store = createCanonicalThreadStore({ threadId: "thread-1" });
    for (const event of events) store.ingest(event as never);
    const snapshot = store.getExecutionSummary();
    const legacy = deriveChildrenView([], [], events);
    expect(
      deriveChildrenViewFromExecutionSummary([], [], events, snapshot, { mode: "off" }),
    ).toEqual(legacy);
    expect(
      deriveChildrenViewFromExecutionSummary([], [], events, snapshot, { mode: "shadow" }),
    ).toEqual(legacy);
    expect(deriveChildrenViewFromExecutionSummary([], [], events, null, { mode: "read" })).toEqual(
      legacy,
    );
  });
});
