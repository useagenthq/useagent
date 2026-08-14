import { resolvePreviewSandbox } from "../runs/preview-proxy";
import { providerEventExists, recordProviderEvent } from "../runs/provider-events";
import {
  ProviderQuestionError,
  questionEventId,
  validateProviderQuestionAnswers,
} from "./provider-question";
import { requestT3Environment } from "./t3-environment-client";
import {
  t3QuestionRequest,
  type T3ThreadSnapshot,
} from "./t3-orchestration";

const T3_QUESTION_TIMEOUT_MS = 15_000;

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

export function t3QuestionAnswers(
  snapshot: T3ThreadSnapshot,
  sessionId: string,
  questionId: string,
  value: unknown,
): Readonly<Record<string, unknown>> {
  const activity = snapshot.thread.activities.findLast((candidate) => {
    const payload = record(candidate.payload);
    return candidate.kind === "user-input.requested" && payload?.requestId === questionId;
  });
  const request = activity ? t3QuestionRequest(activity, sessionId) : null;
  if (!activity || !request) {
    throw new ProviderQuestionError(
      "question_not_pending",
      409,
      "this question is no longer pending on the active T3 session",
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
      "this T3 question has already been answered",
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
        "the pending T3 question is missing its answer key",
      );
    }
    return [id, request.questions[index]?.multiple ? answer : answer[0]];
  }));
}

export async function replyToT3Question(input: {
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
    AbortSignal.timeout(T3_QUESTION_TIMEOUT_MS),
  ]);
  const snapshot = await requestT3Environment<T3ThreadSnapshot>(
    sandbox,
    {
      method: "GET",
      path: `/api/orchestration/threads/${encodeURIComponent(input.sessionId)}`,
    },
    signal,
  );
  const answers = t3QuestionAnswers(snapshot, input.sessionId, input.questionId, input.answers);
  await requestT3Environment(
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
      "the answer reached T3 but its durable receipt could not be recorded",
    );
  }
  return { alreadyAnswered: false };
}
