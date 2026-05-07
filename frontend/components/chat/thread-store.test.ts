// Deterministic reducer tests for the thread-owned store (final_fix.md §5.1).
// Run: `bun test components/chat/thread-store.test.ts` (from frontend/).
//
// The invariant under test: adding/queueing/starting/settling a run never resets
// another run's tools, native frames, children, memory/skill markers, or summary,
// and duplicate replay/live frames produce no visible duplicates.

import { describe, expect, test } from "bun:test";
import { createThreadStore } from "./thread-store";
import { nativeOf } from "./native-ids";
import type { NativeFrame } from "./native-events";
import type { ApiRun, ApiStep, RunStatus, StepKind } from "./types";

let seq = 0;
function step(
  runId: string,
  idx: number,
  kind: StepKind,
  label: string,
  code: Record<string, unknown> | null,
  chip: string | null = null,
): ApiStep {
  return {
    id: `st_${seq++}`,
    run_id: runId,
    idx,
    kind,
    label,
    chip,
    code_json: code ? JSON.stringify(code) : null,
    created_at: new Date(0).toISOString(),
  };
}

const tool = (
  runId: string,
  idx: number,
  toolName: string,
  partID: string,
  callID: string,
  sessionID: string,
  extra: Record<string, unknown> = {},
): ApiStep =>
  step(runId, idx, "command", toolName, {
    tool: toolName,
    ...extra,
    native: { sessionID, messageID: "msg-1", partID, callID },
  });

const childStep = (runId: string, idx: number, parentSession: string, childSession: string): ApiStep =>
  step(
    runId,
    idx,
    "task",
    "Subagent - writer",
    { agent: "general", description: "writer", native: { sessionID: parentSession, partID: `sub_${idx}`, childSessionID: childSession } },
    "subagent",
  );

/** A memory/skill marker step (chip-tagged rows that must survive a run switch). */
const marker = (runId: string, idx: number, chip: string, label: string): ApiStep =>
  step(runId, idx, "task", label, { native: { sessionID: "ses_root", partID: `mk_${idx}` } }, chip);

function frame(runId: string, eventId: string, s: number, eventType = "part.text", payload: unknown = {}): NativeFrame {
  return {
    schemaVersion: 1,
    eventId,
    seq: s,
    provider: "opencode",
    eventType,
    native: { sessionId: "ses_root", parentSessionId: null, messageId: null, partId: null, callId: null },
    payload,
  };
}

function makeRun(
  id: string,
  opts: { status?: RunStatus; summary?: string | null; steps?: ApiStep[]; parent?: string | null } = {},
): ApiRun {
  return {
    id,
    org_id: "org-1",
    user_id: null,
    parent_run_id: opts.parent ?? null,
    prompt: `prompt ${id}`,
    model: "claude-opus-5",
    engine: "opencode",
    status: opts.status ?? "queued",
    summary: opts.summary ?? null,
    duration_ms: null,
    engine_session_id: null,
    memory_scope: "org",
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    steps: opts.steps ?? [],
  };
}

describe("thread-store", () => {
  test("full multi-run lifecycle never resets prior runs", () => {
    const s = createThreadStore();

    // 1. Hydrate run A with text, a tool, a child subagent, and memory+skill markers.
    const aSteps = [
      tool("A", 0, "bash", "prt_a0", "call_a0", "ses_root", { input: { command: "ls" } }),
      childStep("A", 1, "ses_root", "ses_child"),
      tool("A", 2, "write", "prt_a2", "call_a2", "ses_child"), // runs INSIDE the child
      marker("A", 3, "memory", "Remembered a fact"),
      marker("A", 4, "skill", "Loaded skill fast-installs"),
    ];
    s.applySnapshot([makeRun("A", { status: "running", steps: aSteps })]);
    s.applyNative("A", frame("A", "peA_text", 0, "part.text", { text: "working on it" }));
    s.applyNative("A", frame("A", "peA_tool", 1, "part.tool.completed", { type: "tool", tool: "bash" }));
    s.applyDelta("A", "hello ");

    const a0 = s.getSnapshot().byId.get("A")!;
    expect(a0.native.steps.length).toBe(5);
    expect(a0.native.childSessionIds.has("ses_child")).toBe(true);
    expect(a0.native.nativeFrames.length).toBe(2);
    expect(a0.liveText).toBe("hello ");
    const aStepIdsBefore = a0.native.steps.map((st) => st.id);
    const aFrameIdsBefore = a0.native.nativeFrames.map((f) => f.eventId);

    // 2. Receive queued run B.
    s.upsertRun(makeRun("B", { status: "queued", parent: "A" }));

    // 3. Every entity from A is unchanged; B is queued+empty.
    const a1 = s.getSnapshot().byId.get("A")!;
    expect(a1.native.steps.map((st) => st.id)).toEqual(aStepIdsBefore);
    expect(a1.native.nativeFrames.map((f) => f.eventId)).toEqual(aFrameIdsBefore);
    expect(a1.native.childSessionIds.has("ses_child")).toBe(true);
    expect(a1.liveText).toBe("hello ");
    expect(s.getSnapshot().runs.map((r) => r.id)).toEqual(["A", "B"]);
    expect(s.getSnapshot().byId.get("B")!.status).toBe("queued");
    expect(s.getSnapshot().byId.get("B")!.native.steps.length).toBe(0);

    // 4. More delta/native/tool for A while B is queued.
    s.applyStep("A", tool("A", 5, "grep", "prt_a5", "call_a5", "ses_root"));
    s.applyNative("A", frame("A", "peA_more", 2, "part.text", { text: "more" }));
    s.applyDelta("A", "world");

    // 5. A progressed; B still queued+empty.
    const a2 = s.getSnapshot().byId.get("A")!;
    expect(a2.native.steps.length).toBe(6);
    expect(a2.native.nativeFrames.length).toBe(3);
    expect(a2.liveText).toBe("hello world");
    expect(s.getSnapshot().byId.get("B")!.status).toBe("queued");
    expect(s.getSnapshot().byId.get("B")!.native.steps.length).toBe(0);

    // 6. Settle A and start B (A settles via done; B goes running via a run frame).
    s.applyDone("A", "completed");
    s.upsertRun(makeRun("A", { status: "completed", summary: "did the thing", steps: aSteps }));
    s.upsertRun(makeRun("B", { status: "running", parent: "A" }));
    s.applyStep("B", tool("B", 0, "read", "prt_b0", "call_b0", "ses_root2"));
    s.applyNative("B", frame("B", "peB_0", 0, "part.text", { text: "B working" }));

    // 7. B progresses; A is intact + settled with its summary; A's live text cleared.
    const snap = s.getSnapshot();
    expect(snap.byId.get("A")!.status).toBe("completed");
    expect(snap.byId.get("A")!.summary).toBe("did the thing");
    expect(snap.byId.get("A")!.liveText).toBe(""); // cleared on settle
    expect(snap.byId.get("A")!.native.steps.length).toBe(6); // A's tools never vanished
    expect(snap.byId.get("A")!.native.childSessionIds.has("ses_child")).toBe(true);
    expect(snap.byId.get("B")!.status).toBe("running");
    expect(snap.byId.get("B")!.native.steps.length).toBe(1);

    // 8. Add run C and repeat — A and B untouched.
    s.upsertRun(makeRun("C", { status: "queued", parent: "A" }));
    s.applyStep("C", tool("C", 0, "bash", "prt_c0", "call_c0", "ses_root3"));
    const snap2 = s.getSnapshot();
    expect(snap2.runs.map((r) => r.id)).toEqual(["A", "B", "C"]);
    expect(snap2.byId.get("A")!.native.steps.length).toBe(6);
    expect(snap2.byId.get("B")!.native.steps.length).toBe(1);
    expect(snap2.byId.get("C")!.native.steps.length).toBe(1);
  });

  test("replaying the same snapshot and frames twice produces no duplicates", () => {
    const s = createThreadStore();
    const aSteps = [tool("A", 0, "bash", "prt_a0", "call_a0", "ses_root")];
    const run = makeRun("A", { status: "running", steps: aSteps });
    s.applySnapshot([run]);
    s.applyNative("A", frame("A", "peA", 5, "part.tool.completed"));

    const first = s.getSnapshot().byId.get("A")!;
    expect(first.native.steps.length).toBe(1);
    expect(first.native.nativeFrames.length).toBe(1);

    // Full replay again (reconnect): same snapshot + same frame.
    s.applySnapshot([run]);
    s.applyNative("A", frame("A", "peA", 5, "part.tool.completed"));
    s.applyStep("A", aSteps[0]!); // and a live re-emit of the same step

    const again = s.getSnapshot().byId.get("A")!;
    expect(again.native.steps.length).toBe(1); // no duplicate step
    expect(again.native.nativeFrames.length).toBe(1); // no duplicate frame
    expect(nativeOf(again.native.steps[0]!)?.partID).toBe("prt_a0");
  });

  test("an older native revision cannot overwrite a newer one", () => {
    const s = createThreadStore();
    s.upsertRun(makeRun("A", { status: "running" }));
    s.applyNative("A", frame("A", "pe1", 7, "part.tool.completed"));
    s.applyNative("A", frame("A", "pe1", 3, "part.tool.running")); // older seq → ignored
    const snap = s.getSnapshot().byId.get("A")!;
    expect(snap.native.nativeFrames.length).toBe(1);
    expect(snap.native.nativeFrames[0]!.seq).toBe(7);
    expect(snap.native.nativeFrames[0]!.eventType).toBe("part.tool.completed");
  });

  test("settling one run leaves the thread + every other run live", () => {
    const s = createThreadStore();
    s.applySnapshot([
      makeRun("A", { status: "running", steps: [tool("A", 0, "bash", "pa", "ca", "ses_root")] }),
      makeRun("B", { status: "queued", parent: "A" }),
    ]);
    s.applyDone("A", "completed");
    // The store is not reset: both runs remain, B still queued, A's tools intact.
    const snap = s.getSnapshot();
    expect(snap.runs.map((r) => r.id)).toEqual(["A", "B"]);
    expect(snap.byId.get("A")!.status).toBe("completed");
    expect(snap.byId.get("A")!.native.steps.length).toBe(1);
    expect(snap.byId.get("B")!.status).toBe("queued");
  });

  test("getSnapshot is a stable reference until state changes", () => {
    const s = createThreadStore();
    s.upsertRun(makeRun("A", { status: "running", steps: [tool("A", 0, "bash", "pa", "ca", "ses_root")] }));
    const a = s.getSnapshot();
    expect(s.getSnapshot()).toBe(a); // cached — required for useSyncExternalStore
    s.applyNative("A", frame("A", "pe", 1));
    expect(s.getSnapshot()).not.toBe(a); // invalidated on change

    // A stale/duplicate native frame must NOT invalidate (no wasted render).
    const b = s.getSnapshot();
    s.applyNative("A", frame("A", "pe", 1)); // same seq → suppressed
    expect(s.getSnapshot()).toBe(b);
  });

  test("a step/native for an unknown run is held until its run frame arrives", () => {
    const s = createThreadStore();
    // Frame arrives before the run projection (attach/step race) — must not crash,
    // and must surface once the run frame lands.
    s.applyStep("X", tool("X", 0, "bash", "px", "cx", "ses_x"));
    s.applyNative("X", frame("X", "peX", 0));
    expect(s.getSnapshot().runs.length).toBe(0); // no ApiRun yet → not shown
    s.upsertRun(makeRun("X", { status: "running" }));
    const snap = s.getSnapshot().byId.get("X")!;
    expect(snap.native.steps.length).toBe(1); // the earlier step is now visible
    expect(snap.native.nativeFrames.length).toBe(1);
  });
});
