import { describe, expect, test } from "bun:test";
import {
  type CanonicalChildEventLike,
  deriveCanonicalChildren,
  legacySpawnStepIdForCanonical,
  remapCanonicalOwnerByStep,
} from "./canonical-children";
import type { CanonicalEventLike } from "./canonical-timeline";
import type { SubagentModel } from "./subagents";

const event = (
  kind: CanonicalEventLike["kind"],
  seq: number,
  fields: Partial<CanonicalChildEventLike>,
): CanonicalChildEventLike => ({ kind, seq, ts: 1_000 + seq * 100, ...fields });

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

  test("ignores orphan progress before child.started establishes durable identity", () => {
    const model = deriveCanonicalChildren([
      event("child.updated", 1, { childId: "orphan", status: "running" }),
    ]);

    expect(model.cards).toEqual([]);
    expect(model.fidelity.size).toBe(0);
  });

  test("synthesizes a truthful card from terminal-only child completion", () => {
    const model = deriveCanonicalChildren([
      event("child.completed", 1, {
        childId: "task-late-1",
        status: "ok",
        result: "Late task finished.",
        state: {
          status: "completed",
          summary: "Archived the final result",
          model: "gpt-5.6-luna",
          role: "executor",
          resumable: false,
        },
      }),
    ]);

    expect(model.cards).toEqual([{
      id: "canonical-child-task-late-1",
      title: "executor",
      childSessionId: "task-late-1",
      callId: "task-late-1",
      aliases: ["task-late-1"],
      status: "Late task finished.",
      startedAt: 1_100,
      lastActivityAt: 1_100,
    }]);
    expect(model.fidelity.get("task-late-1")).toMatchObject({
      callId: "task-late-1",
      childSessionId: "task-late-1",
      status: "completed",
      resultText: "Late task finished.",
      progress: "Archived the final result",
      model: "gpt-5.6-luna",
      role: "executor",
      resumable: false,
    });
    expect(model.fidelity.get("task-late-1")?.recentActivity).toEqual([
      { at: new Date(1_100).toISOString(), summary: "Archived the final result" },
      { at: new Date(1_100).toISOString(), summary: "Late task finished." },
    ]);
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

  test("records completion result as real child activity instead of an empty zero-activity card", () => {
    const model = deriveCanonicalChildren([
      event("child.started", 1, {
        childId: "child-1",
        launchToolCallId: "tool-1",
        title: "Check checkout validation",
      }),
      event("child.completed", 2, {
        childId: "child-1",
        status: "ok",
        result: "Validation suite passed.",
      }),
    ]);

    expect(model.cards[0]).toMatchObject({
      status: "Validation suite passed.",
      lastActivityAt: 1_200,
    });
    expect(model.fidelity.get("child-1")?.recentActivity).toEqual([
      { at: new Date(1_200).toISOString(), summary: "Validation suite passed." },
    ]);
  });

  test("prefers structured child state and keeps provider metadata without keyword inference", () => {
    const started = event("child.started", 1, {
      childId: "child-structured",
      title: "Researcher",
      state: {
        status: "running",
        summary: "Provider assigned the child",
        lastToolName: "web_search",
        usage: {
          inputTokens: 12,
          outputTokens: 3,
          reasoningOutputTokens: 2,
          providerCacheReads: 4,
        },
        model: "gpt-5.6-luna",
        role: "researcher",
        resumable: true,
      },
    });
    expect(deriveCanonicalChildren([started]).fidelity.get("child-structured")?.usage).toEqual({
      totalTokens: 17,
      inputTokens: 12,
      outputTokens: 3,
      reasoningOutputTokens: 2,
    });

    const model = deriveCanonicalChildren([
      started,
      event("child.updated", 2, {
        childId: "child-structured",
        status: "This sentence contains no lifecycle keyword",
        state: {
          status: "idle",
          summary: "Awaiting another turn",
          lastToolName: "browser",
          usage: { totalTokens: 21, inputTokens: 16, outputTokens: 5 },
          resumable: true,
        },
      }),
    ]);

    expect(model.cards[0]).toMatchObject({ status: "Awaiting another turn" });
    expect(model.fidelity.get("child-structured")).toMatchObject({
      status: "idle",
      progress: "Awaiting another turn",
      lastToolName: "browser",
      usage: { totalTokens: 21, inputTokens: 16, outputTokens: 5 },
      model: "gpt-5.6-luna",
      role: "researcher",
      resumable: true,
    });
  });

  test("keeps legacy child.updated strings backward compatible when structured state is absent", () => {
    const model = deriveCanonicalChildren([
      event("child.started", 1, { childId: "legacy-child" }),
      event("child.updated", 2, { childId: "legacy-child", status: "waiting" }),
    ]);

    expect(model.fidelity.get("legacy-child")).toMatchObject({
      status: "waiting",
      progress: "waiting",
    });
  });

  test("remaps exact native step ownership onto stable canonical card ids", () => {
    const canonical = deriveCanonicalChildren([
      event("child.started", 1, {
        childId: "child-1",
        launchToolCallId: "call-1",
        title: "Research checkout",
      }),
    ]);
    const legacy: SubagentModel = {
      cards: [{
        id: "legacy-spawn-step",
        title: "Research checkout",
        childSessionId: "child-1",
        callId: "call-1",
        aliases: ["call-1", "child-1"],
        status: "Read package.json",
        startedAt: 1_000,
        lastActivityAt: 1_500,
      }],
      ownerByStep: new Map([["child-tool-step", "legacy-spawn-step"]]),
    };

    expect(remapCanonicalOwnerByStep(canonical.cards, legacy)).toEqual(
      new Map([["child-tool-step", "canonical-child-child-1"]]),
    );
    const [canonicalCard] = canonical.cards;
    if (!canonicalCard) throw new Error("expected canonical child card");
    expect(legacySpawnStepIdForCanonical(canonicalCard, legacy)).toBe("legacy-spawn-step");
  });
});
