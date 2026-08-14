import { describe, expect, test } from "bun:test";
import type { NativeFrame } from "./native-events";
import { composeQuestionAnswers, selectPendingQuestion } from "./question-state";

const frame = (
  seq: number,
  eventType: string,
  payload: unknown,
  provider = "opencode",
): NativeFrame => ({
  schemaVersion: 1,
  eventId: `e${seq}`,
  seq,
  provider,
  eventType,
  native: {
    sessionId: "ses_1",
    parentSessionId: null,
    messageId: null,
    partId: null,
    callId: null,
  },
  payload,
});

const asked = frame(1, "question.asked", {
  id: "que_1",
  sessionID: "ses_1",
  questions: [
    {
      header: "Target",
      question: "Where should I deploy?",
      options: [{ label: "Staging", description: "Safer" }],
      multiple: false,
      custom: true,
    },
  ],
});

describe("native question state", () => {
  test("asked is pending until its matching resolution", () => {
    expect(selectPendingQuestion([asked])?.id).toBe("que_1");
    expect(
      selectPendingQuestion([
        asked,
        frame(2, "question.replied", { requestID: "que_1", answers: [["Staging"]] }),
      ]),
    ).toBeNull();
  });

  test("custom single answer replaces a picked option", () => {
    const question = selectPendingQuestion([asked]);
    expect(question).not.toBeNull();
    if (!question) throw new Error("expected a pending question");
    expect(composeQuestionAnswers(question, [["Staging"]], ["Preview"])).toEqual([["Preview"]]);
    expect(composeQuestionAnswers(question, [[]], [""])).toBeNull();
  });

  test("T3 questions use the same durable card state", () => {
    expect(selectPendingQuestion([{ ...asked, provider: "t3" }])?.id).toBe("que_1");
  });
});
