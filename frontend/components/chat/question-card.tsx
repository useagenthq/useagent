"use client";

import { RiCheckLine, RiQuestionLine } from "@remixicon/react";
import { useState } from "react";
import { composeQuestionAnswers, type PendingQuestion } from "@/components/chat/question-state";
import { cx as cn } from "@/utils/cx";

export function QuestionCard({
  request,
  submitting,
  error,
  onSubmit,
}: {
  request: PendingQuestion;
  submitting: boolean;
  error: string | null;
  onSubmit: (answers: string[][]) => void | Promise<void>;
}) {
  const [selected, setSelected] = useState<string[][]>(() => request.questions.map(() => []));
  const [custom, setCustom] = useState<string[]>(() => request.questions.map(() => ""));
  const answers = composeQuestionAnswers(request, selected, custom);

  return (
    <form
      className="border-border-button-default bg-background-secondary-default space-y-4 rounded-2xl border p-4"
      data-testid="native-question-card"
      onSubmit={(event) => {
        event.preventDefault();
        if (answers && !submitting) void onSubmit(answers);
      }}
    >
      <div className="flex items-center gap-2">
        <span className="bg-accent-500/10 text-accent-500 flex size-7 items-center justify-center rounded-full">
          <RiQuestionLine className="size-4" aria-hidden />
        </span>
        <div>
          <p className="text-body-2-medium text-text-primary">Agent needs your input</p>
          <p className="text-caption-1-regular text-text-tertiary">
            Your answer continues this turn immediately.
          </p>
        </div>
      </div>

      {request.questions.map((item, questionIndex) => (
        <fieldset key={`${request.id}:${questionIndex}`} className="space-y-2.5">
          <legend className="space-y-0.5">
            <span className="text-caption-1-medium text-text-secondary block">{item.header}</span>
            <span className="text-body-2-regular text-text-primary block">{item.question}</span>
          </legend>
          {item.options.length > 0 && (
            <div className="grid gap-2 sm:grid-cols-2">
              {item.options.map((option) => {
                const active = selected[questionIndex]?.includes(option.label) ?? false;
                return (
                  <button
                    key={option.label}
                    type="button"
                    aria-pressed={active}
                    onClick={() => {
                      setSelected((current) => {
                        const prior = current[questionIndex] ?? [];
                        const next = item.multiple
                          ? active
                            ? prior.filter((label) => label !== option.label)
                            : [...prior, option.label]
                          : [option.label];
                        return current.with(questionIndex, next);
                      });
                      if (!item.multiple) {
                        setCustom((current) => current.with(questionIndex, ""));
                      }
                    }}
                    className={cn(
                      "flex min-h-12 items-start gap-2 rounded-xl border px-3 py-2 text-left transition-colors",
                      active
                        ? "border-accent-500 bg-accent-500/10"
                        : "border-border-button-default bg-background-primary-default hover:bg-background-secondary-hover",
                    )}
                  >
                    <span
                      className={cn(
                        "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
                        active
                          ? "border-accent-500 bg-accent-500 text-white"
                          : "border-border-button-active",
                      )}
                    >
                      {active && <RiCheckLine className="size-3" aria-hidden />}
                    </span>
                    <span>
                      <span className="text-caption-1-medium text-text-primary block">
                        {option.label}
                      </span>
                      <span className="text-caption-1-regular text-text-tertiary block">
                        {option.description}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          {item.custom && (
            <input
              value={custom[questionIndex] ?? ""}
              onChange={(event) => {
                setCustom((current) => current.with(questionIndex, event.target.value));
                if (!item.multiple) {
                  setSelected((current) => current.with(questionIndex, []));
                }
              }}
              placeholder="Type a custom answer…"
              aria-label={`Custom answer for ${item.header}`}
              className="border-border-button-default bg-background-primary-default text-text-primary placeholder:text-text-tertiary focus:border-accent-500 h-10 w-full rounded-xl border px-3 text-body-2-regular outline-none"
            />
          )}
        </fieldset>
      ))}

      {error && <p className="text-caption-1-regular text-red-500">{error}</p>}
      <div className="flex justify-end">
        <button
          type="submit"
          disabled={!answers || submitting}
          className="bg-accent-500 hover:bg-accent-600 disabled:bg-background-tertiary-default disabled:text-text-tertiary rounded-xl px-3.5 py-2 text-body-2-medium text-white transition-colors disabled:cursor-not-allowed"
        >
          {submitting ? "Sending…" : "Continue"}
        </button>
      </div>
    </form>
  );
}
