import { getOpenCodeThreadServer } from "./opencode-runtime";
import { resolvePreviewSandbox } from "../runs/preview-proxy";
import { providerEventExists, recordProviderEvent } from "../runs/provider-events";
import { sandboxPreviewHeaders } from "../sandboxes/provider";
import type { SecretRedactor } from "../secrets/redact";
import {
  ProviderQuestionError,
  questionEventId,
  redactProviderQuestionPayload,
  validateProviderQuestionAnswers,
  type ProviderQuestionInfo,
  type ProviderQuestionRequest,
} from "./provider-question";

const OPENCODE_PORT = 4096;
const MAX_QUESTIONS = 8;
export {
  ProviderQuestionError as OpenCodeQuestionError,
  questionEventId,
  redactProviderQuestionPayload,
  validateProviderQuestionAnswers as validateOpenCodeQuestionAnswers,
};
export type {
  ProviderQuestionInfo as OpenCodeQuestionInfo,
  ProviderQuestionRequest as OpenCodeQuestionRequest,
};

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

function readQuestionInfo(value: unknown): ProviderQuestionInfo | null {
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
export function parseOpenCodeQuestionRequest(value: unknown): ProviderQuestionRequest | null {
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
    questions: questions as ProviderQuestionInfo[],
    ...(tool && typeof tool.messageID === "string" && typeof tool.callID === "string"
      ? { tool: { messageID: tool.messageID, callID: tool.callID } }
      : {}),
  };
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
    throw new ProviderQuestionError("control_unavailable", 503, "sandbox workspace is unavailable");
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
  readonly redact: Pick<SecretRedactor, "text" | "unknown">;
}): Promise<{ alreadyAnswered: boolean }> {
  const resolvedEventId = questionEventId(input.runId, input.questionId, "replied");
  if (await providerEventExists(resolvedEventId)) return { alreadyAnswered: true };

  const control = await resolveControl(input.threadId);
  const headers = sandboxPreviewHeaders(control.token);
  const directory = `?directory=${encodeURIComponent(control.workdir)}`;
  const list = await fetch(`${control.baseUrl}/question${directory}`, {
    headers,
    signal: AbortSignal.any([input.signal, AbortSignal.timeout(15_000)]),
  }).catch(() => null);
  if (!list) {
    throw new ProviderQuestionError("control_unavailable", 503, "OpenCode question service is unreachable");
  }
  if (!list.ok) {
    throw new ProviderQuestionError(
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
    throw new ProviderQuestionError(
      "question_not_pending",
      409,
      "this question is no longer pending on the active OpenCode session",
    );
  }
  const answers = validateProviderQuestionAnswers(request, input.answers);
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
    throw new ProviderQuestionError("control_unavailable", 503, "OpenCode question reply is unreachable");
  }
  if (!response.ok) {
    throw new ProviderQuestionError(
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
      payload: redactProviderQuestionPayload(
        { sessionID: input.sessionId, requestID: request.id, answers },
        input.redact,
      ),
    },
    { critical: true },
  );
  if (!(await providerEventExists(resolvedEventId))) {
    throw new ProviderQuestionError(
      "reply_persist_failed",
      503,
      "the answer reached OpenCode but its durable receipt could not be recorded",
    );
  }
  return { alreadyAnswered: false };
}
