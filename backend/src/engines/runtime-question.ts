import { resolvePreviewSandbox } from "../runs/preview-proxy";
import { providerEventExists, recordProviderEvent } from "../runs/provider-events";
import {
  ProviderQuestionError,
  questionEventId,
  validateProviderQuestionAnswers,
} from "./provider-question";
import { requestRuntimeEnvironment } from "./runtime-environment-client";
import {
  runtimeQuestionRequest,
  type RuntimeThreadSnapshot,
} from "./runtime-orchestration";

const RUNTIME_QUESTION_TIMEOUT_MS = 15_000;

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

export function runtimeQuestionAnswers(
  snapshot: RuntimeThreadSnapshot,
  sessionId: string,
  questionId: string,
  value: unknown,
): Readonly<Record<string, unknown>> {
  const activity = snapshot.thread.activities.findLast((candidate) => {
    const payload = record(candidate.payload);
    return candidate.kind === "user-input.requested" && payload?.requestId === questionId;
  });
  const request = activity ? runtimeQuestionRequest(activity, sessionId) : null;
  if (!activity || !request) {
    throw new ProviderQuestionError(
      "question_not_pending",
      409,
      "this question is no longer pending on the active provider session",
    );
  }
  const requestedAt = snapshot.thread.activities.findLastIndex(({ id }) => id === activity.id);
  const resolved = snapshot.thread.activities.slice(requestedAt + 1).some((candidate) => {
    const payload = record(candidate.payload);
    return candidate.kind === "user-input.resolved" && payload?.requestId === questionId;
  });
  if (resolved) {
    throw new ProviderQuestionError(
      "question_not_pending",
      409,
      "this question has already been answered",
    );
  }
  const answers = validateProviderQuestionAnswers(request, value);
  const payload = record(activity.payload);
  const nativeQuestions = Array.isArray(payload?.questions) ? payload.questions : [];
  return Object.fromEntries(answers.map((answer, index) => {
    const nativeQuestion = record(nativeQuestions[index]);
    const id = typeof nativeQuestion?.id === "string" ? nativeQuestion.id : null;
    if (!id) {
      throw new ProviderQuestionError(
        "question_invalid",
        409,
        "the pending question is missing its answer key",
      );
    }
    return [id, request.questions[index]?.multiple ? answer : answer[0]];
  }));
}

export async function replyToRuntimeQuestion(input: {
  readonly runId: string;
  readonly threadId: string;
  readonly sessionId: string;
  readonly questionId: string;
  readonly answers: unknown;
  readonly signal: AbortSignal;
}): Promise<{ alreadyAnswered: boolean }> {
  const resolvedEventId = questionEventId(input.runId, input.questionId, "replied");
  if (await providerEventExists(resolvedEventId)) return { alreadyAnswered: true };

  const sandbox = await resolvePreviewSandbox(input.threadId);
  const signal = AbortSignal.any([
    input.signal,
    AbortSignal.timeout(RUNTIME_QUESTION_TIMEOUT_MS),
  ]);
  const snapshot = await requestRuntimeEnvironment<RuntimeThreadSnapshot>(
    sandbox,
    {
      method: "GET",
      path: `/api/orchestration/threads/${encodeURIComponent(input.sessionId)}`,
    },
    signal,
  );
  const answers = runtimeQuestionAnswers(snapshot, input.sessionId, input.questionId, input.answers);
  await requestRuntimeEnvironment(
    sandbox,
    {
      method: "POST",
      path: "/api/orchestration/dispatch",
      payload: {
        type: "thread.user-input.respond",
        commandId: `skynet-user-input-${crypto.randomUUID()}`,
        threadId: input.sessionId,
        requestId: input.questionId,
        answers,
        createdAt: new Date().toISOString(),
      },
    },
    signal,
  );
  await recordProviderEvent({
    id: resolvedEventId,
    runId: input.runId,
    threadId: input.threadId,
    provider: "t3",
    eventType: "question.replied",
    nativeSessionId: input.sessionId,
    payload: { requestID: input.questionId, answers },
  }, { critical: true });
  if (!(await providerEventExists(resolvedEventId))) {
    throw new ProviderQuestionError(
      "reply_persist_failed",
      503,
      "the answer reached the provider runtime but its durable receipt could not be recorded",
    );
  }
  return { alreadyAnswered: false };
}
