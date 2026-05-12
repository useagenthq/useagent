import { getOpenCodeThreadServer } from "./opencode-runtime";
import { resolvePreviewSandbox } from "../runs/preview-proxy";
import { providerEventExists, recordProviderEvent } from "../runs/provider-events";

const OPENCODE_PORT = 4096;
const MAX_QUESTIONS = 8;
const MAX_ANSWERS_PER_QUESTION = 12;
const MAX_ANSWER_CHARS = 4_000;

export interface OpenCodeQuestionOption {
  readonly label: string;
  readonly description: string;
}

export interface OpenCodeQuestionInfo {
  readonly question: string;
  readonly header: string;
  readonly options: readonly OpenCodeQuestionOption[];
  readonly multiple: boolean;
  readonly custom: boolean;
}

export interface OpenCodeQuestionRequest {
  readonly id: string;
  readonly sessionID: string;
  readonly questions: readonly OpenCodeQuestionInfo[];
  readonly tool?: { readonly messageID: string; readonly callID: string };
}

export class OpenCodeQuestionError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 404 | 409 | 502 | 503,
    message: string,
  ) {
    super(message);
  }
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

function readQuestionInfo(value: unknown): OpenCodeQuestionInfo | null {
  const item = record(value);
  if (!item || typeof item.question !== "string" || typeof item.header !== "string") return null;
  if (!Array.isArray(item.options)) return null;
  const options = item.options.flatMap((raw) => {
    const option = record(raw);
    return option && typeof option.label === "string" && typeof option.description === "string"
      ? [{ label: option.label, description: option.description }]
      : [];
  });
  if (options.length !== item.options.length) return null;
  return {
    question: item.question,
    header: item.header,
    options,
    multiple: item.multiple === true,
    custom: item.custom !== false,
  };
}

/** Defensive parser for OpenCode's current Question.Request contract. */
export function parseOpenCodeQuestionRequest(value: unknown): OpenCodeQuestionRequest | null {
  const request = record(value);
  if (
    !request ||
    typeof request.id !== "string" ||
    !request.id.startsWith("que") ||
    typeof request.sessionID !== "string" ||
    !Array.isArray(request.questions) ||
    request.questions.length === 0 ||
    request.questions.length > MAX_QUESTIONS
  ) {
    return null;
  }
  const questions = request.questions.map(readQuestionInfo);
  if (questions.some((question) => question === null)) return null;
  const tool = record(request.tool);
  return {
    id: request.id,
    sessionID: request.sessionID,
    questions: questions as OpenCodeQuestionInfo[],
    ...(tool && typeof tool.messageID === "string" && typeof tool.callID === "string"
      ? { tool: { messageID: tool.messageID, callID: tool.callID } }
      : {}),
  };
}

/** Validate and normalize a user's answer against the live provider request. */
export function validateOpenCodeQuestionAnswers(
  request: OpenCodeQuestionRequest,
  value: unknown,
): string[][] {
  if (!Array.isArray(value) || value.length !== request.questions.length) {
    throw new OpenCodeQuestionError(
      "answers_shape_invalid",
      400,
      `expected ${request.questions.length} answer set(s)`,
    );
  }
  return value.map((rawAnswers, index) => {
    const question = request.questions[index];
    if (!question) {
      throw new OpenCodeQuestionError(
        "answers_shape_invalid",
        400,
        `missing question ${index + 1}`,
      );
    }
    if (
      !Array.isArray(rawAnswers) ||
      rawAnswers.length === 0 ||
      rawAnswers.length > MAX_ANSWERS_PER_QUESTION ||
      (!question.multiple && rawAnswers.length !== 1)
    ) {
      throw new OpenCodeQuestionError(
        "answers_shape_invalid",
        400,
        `invalid answer count for question ${index + 1}`,
      );
    }
    const answers = rawAnswers.map((answer) =>
      typeof answer === "string" ? answer.trim() : "",
    );
    if (answers.some((answer) => answer.length === 0 || answer.length > MAX_ANSWER_CHARS)) {
      throw new OpenCodeQuestionError(
        "answer_invalid",
        400,
        `invalid answer for question ${index + 1}`,
      );
    }
    if (!question.custom) {
      const allowed = new Set(question.options.map((option) => option.label));
      if (answers.some((answer) => !allowed.has(answer))) {
        throw new OpenCodeQuestionError(
          "answer_not_allowed",
          400,
          `question ${index + 1} only accepts its listed options`,
        );
      }
    }
    return answers;
  });
}

export function openCodeQuestionEventId(
  runId: string,
  questionId: string,
  state: "asked" | "replied" | "rejected",
): string {
  return `pe_${runId}_${questionId}_${state}`;
}

async function resolveControl(threadId: string): Promise<{
  baseUrl: string;
  token: string;
  workdir: string;
}> {
  const cached = getOpenCodeThreadServer(threadId);
  if (cached) return cached;

  // Backend restarts lose only the preview cache, not the retained sandbox or
  // its resident OpenCode process. Rebuild the control address from durable
  // thread→sandbox state so a pending question remains answerable.
  const sandbox = await resolvePreviewSandbox(threadId);
  const [home, link] = await Promise.all([
    sandbox.process.executeCommand('printf %s "$HOME"', undefined, undefined, 15),
    sandbox.getPreviewLink(OPENCODE_PORT),
  ]);
  if ((home.exitCode ?? 1) !== 0) {
    throw new OpenCodeQuestionError("control_unavailable", 503, "sandbox workspace is unavailable");
  }
  return {
    baseUrl: link.url.replace(/\/+$/, ""),
    token: link.token ?? "",
    workdir: `${home.result?.trim() || "/home/daytona"}/work`,
  };
}

export async function replyToOpenCodeQuestion(input: {
  readonly runId: string;
  readonly threadId: string;
  readonly sessionId: string;
  readonly questionId: string;
  readonly answers: unknown;
  readonly signal: AbortSignal;
}): Promise<{ alreadyAnswered: boolean }> {
  const resolvedEventId = openCodeQuestionEventId(input.runId, input.questionId, "replied");
  if (await providerEventExists(resolvedEventId)) return { alreadyAnswered: true };

  const control = await resolveControl(input.threadId);
  const headers = { "x-daytona-preview-token": control.token };
  const directory = `?directory=${encodeURIComponent(control.workdir)}`;
  const list = await fetch(`${control.baseUrl}/question${directory}`, {
    headers,
    signal: AbortSignal.any([input.signal, AbortSignal.timeout(15_000)]),
  }).catch(() => null);
  if (!list) {
    throw new OpenCodeQuestionError("control_unavailable", 503, "OpenCode question service is unreachable");
  }
  if (!list.ok) {
    throw new OpenCodeQuestionError(
      "control_failed",
      502,
      `OpenCode question list failed with HTTP ${list.status}`,
    );
  }
  const requests = await list.json().catch(() => null);
  const request = Array.isArray(requests)
    ? requests.map(parseOpenCodeQuestionRequest).find(
        (candidate) =>
          candidate?.id === input.questionId && candidate.sessionID === input.sessionId,
      ) ?? null
    : null;
  if (!request) {
    throw new OpenCodeQuestionError(
      "question_not_pending",
      409,
      "this question is no longer pending on the active OpenCode session",
    );
  }
  const answers = validateOpenCodeQuestionAnswers(request, input.answers);
  const response = await fetch(
    `${control.baseUrl}/question/${encodeURIComponent(request.id)}/reply${directory}`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ answers }),
      signal: AbortSignal.any([input.signal, AbortSignal.timeout(15_000)]),
    },
  ).catch(() => null);
  if (!response) {
    throw new OpenCodeQuestionError("control_unavailable", 503, "OpenCode question reply is unreachable");
  }
  if (!response.ok) {
    throw new OpenCodeQuestionError(
      "reply_failed",
      response.status === 404 ? 409 : 502,
      `OpenCode question reply failed with HTTP ${response.status}`,
    );
  }

  // The provider also emits question.replied. Persist the same stable semantic
  // event here before responding so a lost SSE frame or HTTP response cannot
  // leave the UI stuck; the provider event is an idempotent later revision.
  await recordProviderEvent(
    {
      id: resolvedEventId,
      runId: input.runId,
      threadId: input.threadId,
      provider: "opencode",
      eventType: "question.replied",
      nativeSessionId: input.sessionId,
      nativeCallId: request.tool?.callID ?? null,
      payload: { sessionID: input.sessionId, requestID: request.id, answers },
    },
    { critical: true },
  );
  if (!(await providerEventExists(resolvedEventId))) {
    throw new OpenCodeQuestionError(
      "reply_persist_failed",
      503,
      "the answer reached OpenCode but its durable receipt could not be recorded",
    );
  }
  return { alreadyAnswered: false };
}
