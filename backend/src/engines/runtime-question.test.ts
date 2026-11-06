import { describe, expect, test } from "bun:test";
import { ProviderQuestionError } from "./provider-question";
import {
  runtimeQuestionAnswers,
  runtimeQuestionReplyProviderEvent,
  resolveRuntimeQuestionSandbox,
} from "./runtime-question";
import type { RuntimeThreadSnapshot } from "./runtime-orchestration";
import { createSecretRedactor } from "../secrets/redact";
import { SANDBOX_NAME_PREFIX } from "../sandboxes/sandbox-names";

function snapshot(resolved = false): RuntimeThreadSnapshot {
  return {
    snapshotSequence: resolved ? 3 : 2,
    thread: {
      id: `${SANDBOX_NAME_PREFIX}-thread-thread-1`,
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
  test("strictly resolves a constrained run without consulting the preview cache", async () => {
    const expectedSandbox = {
      version: 1 as const,
      sandboxId: "sandbox-1",
      provider: "cube" as const,
      credential: "env" as const,
      ownerOrgId: "org-1",
      ownerUserId: null,
      credentialGeneration: "a".repeat(64),
    };
    let expectedCalls = 0;
    let previewCalls = 0;
    const dependencies = {
      expected: async (expected, threadId) => {
        expectedCalls += 1;
        expect(expected).toEqual(expectedSandbox);
        expect(threadId).toBe("thread-1");
        return {} as never;
      },
      preview: async () => {
        previewCalls += 1;
        return {} as never;
      },
    } satisfies Parameters<typeof resolveRuntimeQuestionSandbox>[2];
    await resolveRuntimeQuestionSandbox("thread-1", expectedSandbox, dependencies);
    expect(expectedCalls).toBe(1);
    expect(previewCalls).toBe(0);
    await resolveRuntimeQuestionSandbox("thread-1", null, dependencies);
    expect(expectedCalls).toBe(1);
    expect(previewCalls).toBe(1);
  });

  test("maps ordered UseAgent card answers to T3's native question ids", () => {
    expect(runtimeQuestionAnswers(
      snapshot(),
      `${SANDBOX_NAME_PREFIX}-thread-thread-1`,
      "request-1",
      [["React"]],
    )).toEqual({ "Framework?": "React" });
  });

  test("fails closed after the native request resolves", () => {
    expect(() => runtimeQuestionAnswers(
      snapshot(true),
      `${SANDBOX_NAME_PREFIX}-thread-thread-1`,
      "request-1",
      [["React"]],
    )).toThrow(ProviderQuestionError);
  });

  test("redacts synchronous T3 answers without changing the request routing id", () => {
    const secret = "SYNTHETIC_T3_QUESTION_ANSWER_SECRET_123456";
    const event = runtimeQuestionReplyProviderEvent(
      {
        runId: "run-1",
        threadId: "thread-1",
        sessionId: `${SANDBOX_NAME_PREFIX}-thread-thread-1`,
        questionId: "request-stable",
      },
      { [secret]: secret },
      createSecretRedactor([secret]),
    );

    expect(event.payload).toEqual({
      requestID: "request-stable",
      answers: { "<redacted>": "<redacted>" },
    });
    expect(event.nativeSessionId).toBe(`${SANDBOX_NAME_PREFIX}-thread-thread-1`);
  });
});
