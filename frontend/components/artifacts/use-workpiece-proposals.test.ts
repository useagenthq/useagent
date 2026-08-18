import { describe, expect, test } from "bun:test";
import type { OrgChange } from "@/lib/org-changes";
import {
  proposalConflictsWithMainline,
  shouldRefetchProposalsOnSignal,
} from "./use-workpiece-proposals";

const proposed: OrgChange = {
  type: "artifact",
  action: "proposed",
  artifactId: "artifact-1",
  runId: "run-1",
  threadId: "thread-1",
};

describe("proposals lane refetch gate", () => {
  test("an agent proposal firing 'proposed' refetches this workpiece", () => {
    // The live-banner contract: workpiece_propose_edit -> "proposed" -> the open
    // editor reloads its proposals list and the Review banner appears at once.
    expect(shouldRefetchProposalsOnSignal(proposed, "artifact-1")).toBe(true);
  });

  test("an accept advancing mainline ('updated') refetches too", () => {
    expect(shouldRefetchProposalsOnSignal({ ...proposed, action: "updated" }, "artifact-1")).toBe(
      true,
    );
  });

  test("a brand-new artifact ('created') is left to the mount fetch", () => {
    expect(shouldRefetchProposalsOnSignal({ ...proposed, action: "created" }, "artifact-1")).toBe(
      false,
    );
  });

  test("another artifact's proposal signal is ignored", () => {
    expect(shouldRefetchProposalsOnSignal(proposed, "artifact-2")).toBe(false);
  });

  test("a non-artifact change never touches the proposals lane", () => {
    const runChange: OrgChange = {
      type: "run",
      action: "settled",
      runId: "run-1",
      threadId: "thread-1",
    };
    expect(shouldRefetchProposalsOnSignal(runChange, "artifact-1")).toBe(false);
  });
});

describe("proposal conflict detection (base_revision vs mainline)", () => {
  test("a proposal written against the current revision is clean", () => {
    expect(proposalConflictsWithMainline({ base_revision: 3 }, 3)).toBe(false);
  });

  test("a proposal whose base_revision trails mainline is a conflict", () => {
    // Backend accept gates on base_revision === current; a trailing base 409s forever.
    expect(proposalConflictsWithMainline({ base_revision: 1 }, 3)).toBe(true);
  });

  test("an unknown mainline revision (not yet loaded) never flags a conflict", () => {
    expect(proposalConflictsWithMainline({ base_revision: 1 }, null)).toBe(false);
  });
});
