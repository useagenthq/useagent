"use client";

import { QuestionCard } from "@/components/chat/question-card";
import type { PendingQuestion } from "@/components/chat/question-state";

export interface QuestionRequestProps {
  readonly request: PendingQuestion;
  readonly submitting?: boolean;
  readonly error?: string | null;
  readonly onSubmit: (answers: string[][]) => void | Promise<void>;
}

/** Canonical multi-question surface shared with the live session transcript. */
export function QuestionRequest({
  request,
  submitting = false,
  error = null,
  onSubmit,
}: QuestionRequestProps) {
  return (
    <QuestionCard request={request} submitting={submitting} error={error} onSubmit={onSubmit} />
  );
}

export type { PendingQuestion };
