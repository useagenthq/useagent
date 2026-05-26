import { describe, expect, test } from "bun:test";
import { ProviderQuestionError } from "./provider-question";
import { runtimeQuestionAnswers } from "./runtime-question";
import type { RuntimeThreadSnapshot } from "./runtime-orchestration";

function snapshot(resolved = false): RuntimeThreadSnapshot {
  return {
    snapshotSequence: resolved ? 3 : 2,
    thread: {
      id: "skynet-thread-thread-1",
      latestTurn: { turnId: "turn-1", state: "running", assistantMessageId: null },
      messages: [],
      activities: [
        {
          id: "activity-question",
          tone: "info",
          kind: "user-input.requested",
          summary: "User input requested",
          payload: {
            requestId: "request-1",
            questions: [
              {
                id: "Framework?",
                header: "Framework",
                question: "Framework?",
                options: [{ label: "React", description: "React.js" }],
                multiSelect: false,
              },
            ],
          },
          turnId: "turn-1",
        },
        ...(resolved
          ? [{
              id: "activity-resolved",
              tone: "info" as const,
              kind: "user-input.resolved",
              summary: "User input submitted",
              payload: { requestId: "request-1", answers: { "Framework?": "React" } },
              turnId: "turn-1",
            }]
          : []),
      ],
      session: { status: "running", lastError: null },
    },
  };
}

describe("T3 native user input", () => {
  test("maps ordered Skynet card answers to T3's native question ids", () => {
    expect(runtimeQuestionAnswers(
      snapshot(),
      "skynet-thread-thread-1",
      "request-1",
      [["React"]],
    )).toEqual({ "Framework?": "React" });
  });

  test("fails closed after the native request resolves", () => {
    expect(() => runtimeQuestionAnswers(
      snapshot(true),
      "skynet-thread-thread-1",
      "request-1",
      [["React"]],
    )).toThrow(ProviderQuestionError);
  });
});
