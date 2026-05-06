// Deterministic reducer tests for the native session store (Phase 4).
// Run: `bun test components/chat/native-store.test.ts` (from frontend/).

import { describe, expect, test } from "bun:test";
import { createNativeStore, readNative } from "./native-store";
import type { ApiStep, StepKind } from "./types";

let seq = 0;
function step(
  idx: number,
  kind: StepKind,
  label: string,
  code: Record<string, unknown> | null,
  chip: string | null = null,
): ApiStep {
  return {
    id: `st_${seq++}`,
    run_id: "run-1",
    idx,
    kind,
    label,
    chip,
    code_json: code ? JSON.stringify(code) : null,
    created_at: new Date(0).toISOString(),
  };
}

const tool = (
  idx: number,
  toolName: string,
  partID: string,
  callID: string,
  sessionID: string,
  extra: Record<string, unknown> = {},
) =>
  step(idx, "command", toolName, {
    tool: toolName,
    ...extra,
    native: { sessionID, messageID: "msg-1", partID, callID },
  });

describe("native-store", () => {
  test("dedupes running→completed re-emit by native partID (one row, enriched)", () => {
    const s = createNativeStore();
    s.reset([], 0);
    s.ingest(tool(0, "bash", "prt_a", "call_a", "ses_root", { input: { command: "ls" } }), 0);
    s.ingest(
      tool(0, "bash", "prt_a", "call_a", "ses_root", {
        input: { command: "ls" },
        output: "file.txt",
      }),
      0,
    );
    const snap = s.getSnapshot();
    expect(snap.steps.length).toBe(1);
    expect(readNative(snap.steps[0]).partID).toBe("prt_a");
    expect(snap.steps[0].code_json).toContain("file.txt"); // enriched, not dup
  });

  test("collapses SSE↔poller overlap (ingest then ingestAll of the same step)", () => {
    const s = createNativeStore();
    s.reset([], 0);
    const t = tool(1, "read", "prt_b", "call_b", "ses_root");
    s.ingest(t, 0);
    s.ingestAll([t, tool(2, "grep", "prt_c", "call_c", "ses_root")], 0);
    expect(s.getSnapshot().steps.length).toBe(2);
  });

  test("idx fallback keeps native-less rows (boot/done) distinct", () => {
    const s = createNativeStore();
    s.reset([], 0);
    s.ingest(step(0, "task", "Sandbox — booting", null, "opencode"), 0);
    s.ingest(step(1, "done", "done", null), 0);
    expect(s.getSnapshot().steps.length).toBe(2);
  });

  test("indexes tools by callID and parts by partID", () => {
    const s = createNativeStore();
    s.reset([tool(0, "bash", "prt_x", "call_x", "ses_root")], 0);
    const snap = s.getSnapshot();
    expect(snap.tools.get("call_x")?.idx).toBe(0);
    expect(snap.parts.get("prt_x")?.idx).toBe(0);
  });

  test("registers child sessions with parent linkage from subtask steps", () => {
    const s = createNativeStore();
    s.reset([], 0);
    s.ingest(
      step(
        0,
        "task",
        "Subagent — poem writer",
        {
          agent: "general",
          description: "poem writer",
          native: { sessionID: "ses_root", partID: "prt_sub", childSessionID: "ses_child" },
        },
        "subagent",
      ),
      0,
    );
    const child = s.getSnapshot().children.get("ses_child");
    expect(child?.parentSessionID).toBe("ses_root");
    expect(s.getSnapshot().childSessionIds.has("ses_child")).toBe(true);
  });

  test("attributes a child tool by native.sessionID ∈ childSessionIds (not order)", () => {
    const s = createNativeStore();
    s.reset(
      [
        step(
          0,
          "task",
          "Subagent — writer",
          { native: { sessionID: "ses_root", partID: "prt_sub", childSessionID: "ses_child" } },
          "subagent",
        ),
        tool(1, "write", "prt_w", "call_w", "ses_child"), // runs INSIDE the child
      ],
      0,
    );
    const snap = s.getSnapshot();
    const childTool = snap.steps.find((st) => readNative(st).partID === "prt_w")!;
    expect(snap.childSessionIds.has(readNative(childTool).sessionID!)).toBe(true);
  });

  test("generation guard drops stale ingests; reset bumps generation", () => {
    const s = createNativeStore();
    s.reset([], 1);
    s.ingest(tool(0, "bash", "prt_a", "call_a", "ses_root"), 0); // stale gen → dropped
    expect(s.getSnapshot().steps.length).toBe(0);
    s.ingest(tool(0, "bash", "prt_a", "call_a", "ses_root"), 1); // current gen → kept
    expect(s.getSnapshot().steps.length).toBe(1);
    s.reset([], 2); // session switch clears + bumps
    expect(s.getSnapshot().steps.length).toBe(0);
    expect(s.getSnapshot().generation).toBe(2);
  });

  test("projection is idx-ordered regardless of ingest order", () => {
    const s = createNativeStore();
    s.reset([], 0);
    s.ingest(tool(2, "a", "p2", "c2", "ses_root"), 0);
    s.ingest(tool(0, "b", "p0", "c0", "ses_root"), 0);
    s.ingest(tool(1, "c", "p1", "c1", "ses_root"), 0);
    expect(s.getSnapshot().steps.map((st) => st.idx)).toEqual([0, 1, 2]);
  });

  test("getSnapshot returns a stable reference until state changes", () => {
    const s = createNativeStore();
    s.reset([tool(0, "bash", "p", "c", "ses_root")], 0);
    const a = s.getSnapshot();
    const b = s.getSnapshot();
    expect(a).toBe(b); // cached — required for useSyncExternalStore
    s.ingest(tool(1, "read", "p2", "c2", "ses_root"), 0);
    expect(s.getSnapshot()).not.toBe(a); // invalidated on change
  });
});
