import { expect, test } from "bun:test";
import {
  threadFamilyShouldRefresh,
  threadSubmissionLane,
} from "./use-thread-family";

test("family invalidation ignores unrelated run changes", () => {
  const child = {
    threadId: "child",
    parentThreadId: "root",
    familyThreadId: "root",
  } as never;
  const state = { relationship: child, children: [child] };
  expect(threadFamilyShouldRefresh(state, "child", {
    type: "run", action: "settled", runId: "run", threadId: "root",
  })).toBe(true);
  expect(threadFamilyShouldRefresh(state, "child", {
    type: "run", action: "settled", runId: "run", threadId: "child",
  })).toBe(true);
  expect(threadFamilyShouldRefresh(state, "child", {
    type: "run", action: "settled", runId: "run", threadId: "unrelated",
  })).toBe(false);
});

test("a new unknown child invalidates the open parent family", () => {
  expect(threadFamilyShouldRefresh({ relationship: null, children: [] }, "root", {
    type: "thread_relationship",
    action: "created",
    threadId: "new-child",
    familyThreadId: "root",
  })).toBe(true);
  expect(threadFamilyShouldRefresh({ relationship: null, children: [] }, "other-root", {
    type: "thread_relationship",
    action: "created",
    threadId: "new-child",
    familyThreadId: "root",
  })).toBe(false);
});

test("only concrete or ambiguous product-child hints fail closed", () => {
  const unresolved = { ready: false, isProductChild: false };
  expect(threadSubmissionLane(unresolved, "root")).toBe("root");
  expect(threadSubmissionLane(unresolved, "legacy_or_off")).toBe("root");
  expect(threadSubmissionLane(unresolved, "child")).toBe("blocked");
  expect(threadSubmissionLane(unresolved, "ambiguous")).toBe("blocked");
  expect(threadSubmissionLane({ ready: true, isProductChild: true }, "root")).toBe("child");
});
