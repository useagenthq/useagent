import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
// Booting the app applies the migrations the stored rows are read through.
import "./helpers";
import { db } from "../src/db/client";
import { providerEvents, runs } from "../src/db/schema";
import { drainProviderEvents } from "../src/runs/provider-events";
import { createSecretRedactor } from "../src/secrets/redact";
import type { RuntimeThreadSnapshot } from "../src/engines/runtime-orchestration";
import { runtimeThreadView } from "../src/engines/runtime-v2-view";
import { v2Item, v2Projection, v2Snapshot } from "../src/engines/runtime-v2.test-support";
import { createTurnProjector } from "../src/engines/turn-projector";
import type { EmitStep, EngineRunContext } from "../src/engines/types";

// What a runtime that sends an edit's two strings would send (the pinned one
// sends neither): one completed change to one file.
function editSnapshot(): RuntimeThreadSnapshot {
  const view = runtimeThreadView(v2Snapshot(1, v2Projection({
    turnItems: [v2Item({
      id: "f1", type: "file_change", runId: "r1", fileName: "/w/src/a.ts",
      oldStr: "export const b = 2;", newStr: "export const b = 3;",
    })],
  })));
  return {
    snapshotSequence: 1,
    thread: {
      id: view.thread.id,
      latestTurn: { turnId: "r1", state: "running", assistantMessageId: null },
      messages: [],
      activities: view.thread.activities,
      session: null,
    },
  };
}

describe("a file change's text through the turn projector", () => {
  test("the step holds the strings the edit replaced and wrote; the ledger row holds neither", async () => {
    const runId = `run-file-text-${crypto.randomUUID()}`;
    await db.insert(runs).values({
      id: runId, orgId: `org-${runId}`, userId: "user-1", prompt: "edit a file", model: "model-1",
      engine: "opencode", status: "running", threadId: runId,
    });
    const emitted: EmitStep[] = [];
    const ctx = {
      runId, threadId: runId,
      emit: async (step: EmitStep) => `step-${emitted.push(step)}`,
    } as unknown as EngineRunContext;
    const projector = createTurnProjector({ ctx, redact: createSecretRedactor([]), engine: "opencode", seen: new Map() });

    await projector.apply(editSnapshot());

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ kind: "file" });
    expect((emitted[0]!.code_json as { input: unknown }).input).toEqual({
      files: [{ path: "/w/src/a.ts" }], file_path: "/w/src/a.ts",
      old_string: "export const b = 2;", new_string: "export const b = 3;",
    });

    await drainProviderEvents(runId);
    const rows = await db.select().from(providerEvents).where(eq(providerEvents.runId, runId));
    const change = rows.filter((row) => row.eventType === "t3.activity.tool.completed");
    expect(change).toHaveLength(1);
    expect(JSON.parse(change[0]!.payload!).payload).toMatchObject({ itemType: "file_change", data: { files: [{ path: "/w/src/a.ts" }] } });
    expect(rows.map((row) => row.payload ?? "").join("\n")).not.toContain("export const b");
  });
});
