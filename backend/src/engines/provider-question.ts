import type { SecretRedactor } from "../secrets/redact";

const MAX_ANSWERS_PER_QUESTION = 12;
const MAX_ANSWER_CHARS = 4_000;

export interface ProviderQuestionOption {
  readonly label: string;
  readonly description: string;
}

export interface ProviderQuestionInfo {
  readonly question: string;
  readonly header: string;
  readonly options: readonly ProviderQuestionOption[];
  readonly multiple: boolean;
  readonly custom: boolean;
}

export interface ProviderQuestionRequest {
  readonly id: string;
  readonly sessionID: string;
  readonly questions: readonly ProviderQuestionInfo[];
  readonly tool?: { readonly messageID: string; readonly callID: string };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Redact question content while retaining native identifiers needed to
 * correlate and resume a pending request. */
export function redactProviderQuestionPayload<T>(
  value: T,
  redact: Pick<SecretRedactor, "text" | "unknown">,
): T {
  const source = record(value);
  if (!source) return redact.unknown(value);
  const safe = record(redact.unknown(value));
  if (!safe) return redact.unknown(value);

  for (const key of ["id", "sessionID", "requestID", "requestId"] as const) {
    if (typeof source[key] === "string") safe[key] = source[key];
  }
  const sourceTool = record(source.tool);
  const safeTool = record(safe.tool);
  if (sourceTool && safeTool) {
    for (const key of ["messageID", "callID"] as const) {
      if (typeof sourceTool[key] === "string") safeTool[key] = sourceTool[key];
    }
  }
  const sourceAnswers = record(source.answers);
  if (sourceAnswers) {
    safe.answers = Object.fromEntries(
      Object.entries(sourceAnswers).map(([key, answer]) => [
        redact.text(key),
        redact.unknown(answer),
      ]),
    );
  }
  return safe as T;
}

export class ProviderQuestionError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 404 | 409 | 502 | 503,
    message: string,
  ) {
    super(message);
  }
}

export function validateProviderQuestionAnswers(
  request: ProviderQuestionRequest,
  value: unknown,
): string[][] {
  if (!Array.isArray(value) || value.length !== request.questions.length) {
    throw new ProviderQuestionError(
      "answers_shape_invalid",
      400,
      `expected ${request.questions.length} answer set(s)`,
    );
  }
  return value.map((rawAnswers, index) => {
    const question = request.questions[index];
    if (!question) {
      throw new ProviderQuestionError(
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
      throw new ProviderQuestionError(
        "answers_shape_invalid",
        400,
        `invalid answer count for question ${index + 1}`,
      );
    }
    const answers = rawAnswers.map((answer) =>
      typeof answer === "string" ? answer.trim() : "",
    );
    if (answers.some((answer) => answer.length === 0 || answer.length > MAX_ANSWER_CHARS)) {
      throw new ProviderQuestionError(
        "answer_invalid",
        400,
        `invalid answer for question ${index + 1}`,
      );
    }
    if (!question.custom) {
      const allowed = new Set(question.options.map((option) => option.label));
      if (answers.some((answer) => !allowed.has(answer))) {
        throw new ProviderQuestionError(
          "answer_not_allowed",
          400,
          `question ${index + 1} only accepts its listed options`,
        );
      }
    }
    return answers;
  });
}

export function questionEventId(
  runId: string,
  questionId: string,
  state: "asked" | "replied" | "rejected",
): string {
  return `pe_${runId}_${questionId}_${state}`;
}
