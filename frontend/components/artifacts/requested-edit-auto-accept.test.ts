import { describe, expect, test } from "bun:test";
import type { ArtifactWorkpieceProposalDescriptor } from "@useagent/agent-client";
import {
  type AutoAcceptGate,
  performUndoAutoAccept,
  selectRequestedEditAutoAccept,
  shouldAutoAcceptRequestedEdit,
} from "./requested-edit-auto-accept";

function proposal(
  over: Partial<ArtifactWorkpieceProposalDescriptor> = {},
): ArtifactWorkpieceProposalDescriptor {
  return {
    id: "prop-1",
    artifact_id: "art-1",
    proposer_run_id: "run-latest",
    kind: "document",
    base_revision: 3,
    summary: "Bold the heading",
    status: "pending",
    created_at: "2026-08-18T00:00:00.000Z",
    resolved_at: null,
    resolved_by: null,
    resolved_revision: null,
    state: { text: "agent revision" },
    ...over,
  };
}

// The clean, idle, same-run, no-conflict baseline: the one case that auto-accepts.
const cleanGate: AutoAcceptGate = {
  editorDirty: false,
  editorRecentlyActive: false,
  latestRunId: "run-latest",
  mainlineRevision: 3,
};

describe("shouldAutoAcceptRequestedEdit", () => {
  test("auto-accepts when clean, from the latest run, and no conflict", () => {
    // "Your chat message WAS the acceptance": the agent change applies directly.
    expect(shouldAutoAcceptRequestedEdit(proposal(), cleanGate)).toBe(true);
  });

  test("does NOT auto-accept when the editor is dirty", () => {
    expect(shouldAutoAcceptRequestedEdit(proposal(), { ...cleanGate, editorDirty: true })).toBe(
      false,
    );
  });

  test("does NOT auto-accept when the editor was edited/focused seconds ago", () => {
    expect(
      shouldAutoAcceptRequestedEdit(proposal(), { ...cleanGate, editorRecentlyActive: true }),
    ).toBe(false);
  });

  test("does NOT auto-accept a proposal from a different (not the latest) run", () => {
    expect(shouldAutoAcceptRequestedEdit(proposal({ proposer_run_id: "run-old" }), cleanGate)).toBe(
      false,
    );
  });

  test("does NOT auto-accept outside a session (no latest run)", () => {
    expect(shouldAutoAcceptRequestedEdit(proposal(), { ...cleanGate, latestRunId: null })).toBe(
      false,
    );
  });

  test("does NOT auto-accept on a conflict (base_revision behind mainline)", () => {
    expect(shouldAutoAcceptRequestedEdit(proposal({ base_revision: 2 }), cleanGate)).toBe(false);
  });

  test("does NOT auto-accept while mainline revision is still unknown", () => {
    expect(
      shouldAutoAcceptRequestedEdit(proposal(), { ...cleanGate, mainlineRevision: null }),
    ).toBe(false);
  });

  test("does NOT auto-accept an already-resolved proposal", () => {
    expect(shouldAutoAcceptRequestedEdit(proposal({ status: "accepted" }), cleanGate)).toBe(false);
  });
});

describe("selectRequestedEditAutoAccept", () => {
  test("picks the newest qualifying proposal, skipping already-seen ids", () => {
    const older = proposal({ id: "older" });
    const newer = proposal({ id: "newer" });
    const seenOne = proposal({ id: "seen" });
    const chosen = selectRequestedEditAutoAccept({
      pending: [seenOne, older, newer],
      seenProposalIds: new Set(["seen"]),
      gate: cleanGate,
    });
    expect(chosen?.id).toBe("newer");
  });

  test("returns null when nothing qualifies (editor dirty)", () => {
    expect(
      selectRequestedEditAutoAccept({
        pending: [proposal()],
        seenProposalIds: new Set(),
        gate: { ...cleanGate, editorDirty: true },
      }),
    ).toBeNull();
  });

  test("returns null when the only candidate was already seen", () => {
    expect(
      selectRequestedEditAutoAccept({
        pending: [proposal({ id: "prop-1" })],
        seenProposalIds: new Set(["prop-1"]),
        gate: cleanGate,
      }),
    ).toBeNull();
  });
});

describe("performUndoAutoAccept", () => {
  test("re-saves the captured prior state at the current revision", async () => {
    const patched: Array<{ rev: number; state: unknown }> = [];
    const ok = await performUndoAutoAccept({
      priorState: { text: "original" },
      readRevision: async () => 4,
      patch: async (rev, state) => {
        patched.push({ rev, state });
        return 200;
      },
    });
    expect(ok).toBe(true);
    // The prior state is re-saved as a new revision against current mainline (4).
    expect(patched).toEqual([{ rev: 4, state: { text: "original" } }]);
  });

  test("retries once on a 409 with the freshly re-read revision", async () => {
    const revisions = [4, 5];
    const attempts: number[] = [];
    const ok = await performUndoAutoAccept({
      priorState: { text: "original" },
      readRevision: async () => revisions.shift() ?? null,
      patch: async (rev) => {
        attempts.push(rev);
        return rev === 4 ? 409 : 200;
      },
    });
    expect(ok).toBe(true);
    expect(attempts).toEqual([4, 5]);
  });

  test("fails (no re-save) when the current revision cannot be read", async () => {
    let patchCalls = 0;
    const ok = await performUndoAutoAccept({
      priorState: { text: "original" },
      readRevision: async () => null,
      patch: async () => {
        patchCalls++;
        return 200;
      },
    });
    expect(ok).toBe(false);
    expect(patchCalls).toBe(0);
  });
});
