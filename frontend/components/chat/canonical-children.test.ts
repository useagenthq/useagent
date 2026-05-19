import { describe, expect, test } from "bun:test";
import { deriveCanonicalChildren } from "./canonical-children";
import type { CanonicalEventLike } from "./canonical-timeline";

const event = (
  kind: CanonicalEventLike["kind"],
  seq: number,
  fields: Partial<CanonicalEventLike>,
): CanonicalEventLike => ({ kind, seq, ts: 1_000 + seq * 100, ...fields });

describe("canonical child projection", () => {
  test("folds one durable child lifecycle into a truthful card and fidelity record", () => {
    const model = deriveCanonicalChildren([
      event("child.started", 1, {
        childId: "child-1",
        launchToolCallId: "tool-1",
        title: "Check checkout validation",
      }),
      event("child.updated", 2, { childId: "child-1", status: "Running focused tests" }),
      event("child.completed", 3, {
        childId: "child-1",
        status: "ok",
        result: "Validation suite passed.",
      }),
    ]);

    expect(model.cards).toHaveLength(1);
    expect(model.cards[0]).toMatchObject({
      id: "canonical-child-child-1",
      title: "Check checkout validation",
      childSessionId: "child-1",
      callId: "tool-1",
      aliases: ["tool-1", "child-1"],
      status: "Running focused tests",
      startedAt: 1_100,
      lastActivityAt: 1_300,
    });
    expect(model.fidelity.get("child-1")).toMatchObject({
      callId: "tool-1",
      childSessionId: "child-1",
      status: "completed",
      progress: "Running focused tests",
      resultText: "Validation suite passed.",
    });
  });

  test("does not invent a card before child.started establishes durable identity", () => {
    const model = deriveCanonicalChildren([
      event("child.updated", 1, { childId: "orphan", status: "running" }),
      event("child.completed", 2, { childId: "orphan", status: "error", result: "failed" }),
    ]);

    expect(model.cards).toEqual([]);
    expect(model.fidelity.size).toBe(0);
  });

  test("keeps siblings independent and maps terminal errors without parent-liveness guesses", () => {
    const model = deriveCanonicalChildren([
      event("child.started", 1, { childId: "a", title: "Alpha" }),
      event("child.started", 2, { childId: "b", title: "Beta" }),
      event("child.updated", 3, { childId: "a", status: "waiting" }),
      event("child.completed", 4, { childId: "b", status: "error", result: "quota" }),
    ]);

    expect(model.fidelity.get("a")?.status).toBe("waiting");
    expect(model.fidelity.get("b")?.status).toBe("failed");
    expect(model.fidelity.get("b")?.resultText).toBe("quota");
  });
});
