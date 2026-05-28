"use client";

import { RiCheckLine, RiQuestionLine } from "@remixicon/react";
import { useState } from "react";
import { composeQuestionAnswers, type PendingQuestion } from "@/components/chat/question-state";
import { cnExt as cn } from "@/utils/cn";

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
      className="border-stroke-soft-200 bg-bg-weak-50 space-y-4 rounded-2xl border p-4"
      data-testid="native-question-card"
      onSubmit={(event) => {
        event.preventDefault();
        if (answers && !submitting) void onSubmit(answers);
      }}
    >
      <div className="flex items-center gap-2">
        <span className="bg-primary-alpha-10 text-primary-base flex size-7 items-center justify-center rounded-full">
          <RiQuestionLine className="size-4" aria-hidden />
        </span>
        <div>
          <p className="text-label-sm text-text-strong-950">Agent needs your input</p>
          <p className="text-paragraph-xs text-text-soft-400">
            Your answer continues this turn immediately.
          </p>
        </div>
      </div>

      {request.questions.map((item, questionIndex) => (
        <fieldset key={`${request.id}:${questionIndex}`} className="space-y-2.5">
          <legend className="space-y-0.5">
            <span className="text-label-xs text-text-sub-600 block">{item.header}</span>
            <span className="text-paragraph-sm text-text-strong-950 block">{item.question}</span>
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
                        ? "border-primary-base bg-primary-alpha-10"
                        : "border-stroke-soft-200 bg-bg-white-0 hover:bg-bg-soft-200",
                    )}
                  >
                    <span
                      className={cn(
                        "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
                        active
                          ? "border-primary-base bg-primary-base text-white"
                          : "border-stroke-strong-400",
                      )}
                    >
                      {active && <RiCheckLine className="size-3" aria-hidden />}
                    </span>
                    <span>
                      <span className="text-label-xs text-text-strong-950 block">
                        {option.label}
                      </span>
                      <span className="text-paragraph-xs text-text-soft-400 block">
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
              className="border-stroke-soft-200 bg-bg-white-0 text-text-strong-950 placeholder:text-text-soft-400 focus:border-primary-base h-10 w-full rounded-xl border px-3 text-paragraph-sm outline-none"
            />
          )}
        </fieldset>
      ))}

      {error && <p className="text-paragraph-xs text-error-base">{error}</p>}
      <div className="flex justify-end">
        <button
          type="submit"
          disabled={!answers || submitting}
          className="bg-primary-base hover:bg-primary-darker disabled:bg-bg-soft-200 disabled:text-text-soft-400 rounded-xl px-3.5 py-2 text-label-sm text-white transition-colors disabled:cursor-not-allowed"
        >
          {submitting ? "Sending…" : "Continue"}
        </button>
      </div>
    </form>
  );
}
