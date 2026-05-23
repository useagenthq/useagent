import { describe, expect, test } from "bun:test";
import type { OrgChange } from "@/lib/org-changes";
import { shouldRefetchProposalsOnSignal } from "./use-workpiece-proposals";

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
