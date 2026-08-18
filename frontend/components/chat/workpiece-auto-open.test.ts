import { describe, expect, test } from "bun:test";
import type { OrgChange } from "@/lib/org-changes";
import { autoOpenArtifactId, shouldFocusAutoOpened } from "./workpiece-auto-open";

const created: OrgChange = {
  type: "artifact",
  action: "created",
  artifactId: "artifact-1",
  runId: "run-1",
  threadId: "thread-1",
};

describe("auto-open target from an org-change (thread-scoped, live-only)", () => {
  test("a workpiece created in the viewed thread is the auto-open target", () => {
    expect(autoOpenArtifactId(created, "thread-1")).toBe("artifact-1");
  });

  test("another thread's creation is never auto-opened", () => {
    expect(autoOpenArtifactId(created, "thread-2")).toBeNull();
  });

  test("a mainline update never auto-opens (only a fresh publish does)", () => {
    expect(autoOpenArtifactId({ ...created, action: "updated" }, "thread-1")).toBeNull();
  });

  test("a proposal signal never auto-opens the pane", () => {
    expect(autoOpenArtifactId({ ...created, action: "proposed" }, "thread-1")).toBeNull();
  });

  test("a non-artifact change is ignored", () => {
    const runChange: OrgChange = {
      type: "run",
      action: "created",
      runId: "run-1",
      threadId: "thread-1",
    };
    expect(autoOpenArtifactId(runChange, "thread-1")).toBeNull();
  });
});

describe("auto-open focus rule (never steal focus mid-typing)", () => {
  test("an idle pane lets the new workpiece take focus", () => {
    expect(shouldFocusAutoOpened({ dirty: false, focused: false })).toBe(true);
  });

  test("a focused-but-clean surface still yields focus to the new tab", () => {
    expect(shouldFocusAutoOpened({ dirty: false, focused: true })).toBe(true);
  });

  test("a dirty surface without focus does not block the switch", () => {
    expect(shouldFocusAutoOpened({ dirty: true, focused: false })).toBe(true);
  });

  test("a surface the user is actively editing keeps focus - the tab is added quietly", () => {
    expect(shouldFocusAutoOpened({ dirty: true, focused: true })).toBe(false);
  });
});
