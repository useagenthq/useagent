import type { NativeFrame } from "./native-events";
import { asRecord } from "./types";

export interface QuestionOption {
  readonly label: string;
  readonly description: string;
}

export interface QuestionItem {
  readonly header: string;
  readonly question: string;
  readonly options: readonly QuestionOption[];
  readonly multiple: boolean;
  readonly custom: boolean;
}

export interface PendingQuestion {
  readonly id: string;
  readonly sessionId: string;
  readonly questions: readonly QuestionItem[];
}

/** Native-question replies resume an existing provider turn and therefore have
 * no run-intake boundary where new resources could be authorized. */
export function composerAcceptsRunResources(question: PendingQuestion | null): boolean {
  return question === null;
}

function parseQuestion(frame: NativeFrame): PendingQuestion | null {
  const payload = asRecord(frame.payload);
  if (
    !payload ||
    typeof payload.id !== "string" ||
    typeof payload.sessionID !== "string" ||
    !Array.isArray(payload.questions)
  ) {
    return null;
  }
  const questions = payload.questions.flatMap((raw) => {
    const item = asRecord(raw);
    if (!item || typeof item.question !== "string" || typeof item.header !== "string") return [];
    if (!Array.isArray(item.options)) return [];
    const options = item.options.flatMap((rawOption) => {
      const option = asRecord(rawOption);
      return option && typeof option.label === "string" && typeof option.description === "string"
        ? [{ label: option.label, description: option.description }]
        : [];
    });
    if (options.length !== item.options.length) return [];
    return [
      {
        header: item.header,
        question: item.question,
        options,
        multiple: item.multiple === true,
        custom: item.custom !== false,
      },
    ];
  });
  if (questions.length === 0 || questions.length !== payload.questions.length) return null;
  return { id: payload.id, sessionId: payload.sessionID, questions };
}

/** Latest still-pending native question. Asked/replied/rejected are durable
 * frames, so reload and live streaming produce the same result. */
export function selectPendingQuestion(frames: readonly NativeFrame[]): PendingQuestion | null {
  const pending = new Map<string, PendingQuestion>();
  for (const frame of [...frames].sort((a, b) => a.seq - b.seq)) {
    if (frame.provider !== "opencode" && frame.provider !== "t3") continue;
    if (frame.eventType === "question.asked") {
      const question = parseQuestion(frame);
      if (question) pending.set(question.id, question);
      continue;
    }
    if (frame.eventType === "question.replied" || frame.eventType === "question.rejected") {
      const payload = asRecord(frame.payload);
      if (typeof payload?.requestID === "string") pending.delete(payload.requestID);
    }
  }
  return [...pending.values()].at(-1) ?? null;
}

/** Convert card selection/custom-input state into OpenCode's ordered answers. */
export function composeQuestionAnswers(
  question: PendingQuestion,
  selected: readonly (readonly string[])[],
  custom: readonly string[],
): string[][] | null {
  const answers = question.questions.map((item, index) => {
    const typed = custom[index]?.trim() ?? "";
    const picked = [...(selected[index] ?? [])];
    if (!item.multiple && typed) return [typed];
    const merged = typed ? [...picked, typed] : picked;
    return [...new Set(merged)];
  });
  return answers.every((answer) => answer.length > 0) ? answers : null;
}
