"use client";

import {
  RiCheckLine,
  RiCloseLine,
  RiRefreshLine,
  RiScissorsLine,
  RiSendPlane2Line,
  RiSparkling2Line,
} from "@remixicon/react";
import { AnimatePresence, motion } from "motion/react";
import type { FormEvent, KeyboardEventHandler, Ref } from "react";

import type { SelectionActionsPhase } from "./selection-actions-model";

interface SelectionActionsToolbarProps {
  phase: SelectionActionsPhase;
  request: string | null;
  prompt: string;
  reducedMotion: boolean | null;
  toolbarRef: Ref<HTMLDivElement>;
  keepRef: Ref<HTMLButtonElement>;
  improveRef: Ref<HTMLButtonElement>;
  onKeyDown: KeyboardEventHandler<HTMLDivElement>;
  onKeep: () => void;
  onDiscard: () => void;
  onRetry: () => void;
  onPromptChange: (value: string) => void;
  onPromptSubmit: () => void;
  onRequest: (request: string) => void;
}

const IDLE_ACTION_CLASS =
  "inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 text-paragraph-sm text-text-sub-600 outline-none transition-[background-color,color,transform] hover:bg-bg-soft-200 hover:text-text-strong-950 active:scale-[0.97] focus-visible:bg-bg-soft-200 focus-visible:text-text-strong-950 focus-visible:ring-2 focus-visible:ring-primary-base";

function busyLabel(request: string | null): string {
  if (request === "shorten") return "Shortening";
  if (request === "improve") return "Improving";
  return "Rewriting";
}

export function SelectionActionsToolbar({
  phase,
  request,
  prompt,
  reducedMotion,
  toolbarRef,
  keepRef,
  improveRef,
  onKeyDown,
  onKeep,
  onDiscard,
  onRetry,
  onPromptChange,
  onPromptSubmit,
  onRequest,
}: SelectionActionsToolbarProps) {
  const resultVisible = phase === "result";

  function submitPrompt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onPromptSubmit();
  }

  return (
    <motion.div
      ref={toolbarRef}
      layout="size"
      role="toolbar"
      aria-label={resultVisible ? "Review rewrite" : "Selection actions"}
      onKeyDown={onKeyDown}
      initial={reducedMotion ? false : { opacity: 0, scale: 0.92, y: -4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.94, y: -3 }}
      className={`flex h-10 max-w-[calc(100vw-2rem)] items-center justify-center overflow-hidden rounded-full p-1 [box-shadow:0_18px_40px_-14px_hsl(var(--overlay)),0_0_0_1px_hsl(var(--stroke-sub-300))] ${
        resultVisible ? "bg-bg-strong-950 text-text-white-0" : "bg-bg-weak-50 text-text-strong-950"
      }`}
    >
      <AnimatePresence initial={false} mode="popLayout">
        {phase === "thinking" || phase === "streaming" ? (
          <motion.div
            key="busy"
            initial={reducedMotion ? false : { opacity: 0, x: 5 }}
            animate={{ opacity: 1, x: 0 }}
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, x: -5 }}
            className="inline-flex h-8 items-center gap-2 whitespace-nowrap px-3 text-paragraph-sm text-text-sub-600"
            aria-live="polite"
          >
            <span className="size-3.5 animate-spin rounded-full border-2 border-stroke-sub-300 border-t-text-sub-600 motion-reduce:animate-none" />
            <span className={phase === "thinking" ? "agent-progress-loading-text" : undefined}>
              {busyLabel(request)}…
            </span>
          </motion.div>
        ) : resultVisible ? (
          <motion.div
            key="result"
            initial={reducedMotion ? false : { opacity: 0, x: 6 }}
            animate={{ opacity: 1, x: 0 }}
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, x: -6 }}
            className="flex items-center gap-0.5"
          >
            <button
              ref={keepRef}
              type="button"
              onClick={onKeep}
              className="inline-flex h-8 items-center gap-1.5 rounded-full bg-bg-white-0 px-3.5 text-paragraph-md text-text-strong-950 shadow-regular-xs outline-none transition-transform active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-primary-base focus-visible:ring-offset-2 focus-visible:ring-offset-bg-strong-950"
            >
              <RiCheckLine className="size-4" aria-hidden />
              Keep
            </button>
            <button
              type="button"
              onClick={onDiscard}
              className="inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-paragraph-md text-text-white-0 outline-none transition-[background-color,transform] hover:bg-bg-surface-800 active:scale-[0.97] focus-visible:bg-bg-surface-800 focus-visible:ring-2 focus-visible:ring-primary-base"
            >
              <RiCloseLine className="size-4" aria-hidden />
              Discard
            </button>
            <span className="mx-1 h-5 w-px bg-text-white-0/20" aria-hidden />
            <button
              type="button"
              aria-label="Regenerate rewrite"
              onClick={onRetry}
              className="flex size-8 items-center justify-center rounded-full text-text-white-0/70 outline-none transition-[background-color,color,transform] hover:bg-bg-surface-800 hover:text-text-white-0 active:scale-[0.96] focus-visible:bg-bg-surface-800 focus-visible:text-text-white-0 focus-visible:ring-2 focus-visible:ring-primary-base"
            >
              <RiRefreshLine className="size-5" aria-hidden />
            </button>
          </motion.div>
        ) : (
          <motion.div
            key="idle"
            initial={reducedMotion ? false : { opacity: 0, x: -6 }}
            animate={{ opacity: 1, x: 0 }}
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, x: 6 }}
            className="flex items-center gap-0.5"
          >
            <form onSubmit={submitPrompt} className="flex h-8 items-center">
              <input
                value={prompt}
                onChange={(event) => onPromptChange(event.target.value)}
                aria-label="Describe edits"
                placeholder="Describe edits"
                className="h-8 w-24 bg-transparent px-3 text-paragraph-sm text-text-strong-950 outline-none placeholder:text-text-soft-400 sm:w-32"
              />
              {prompt.trim() && (
                <button
                  type="submit"
                  aria-label="Send edit instruction"
                  className="mr-0.5 flex size-7 items-center justify-center rounded-full bg-bg-strong-950 text-text-white-0 outline-none transition-transform active:scale-[0.96] focus-visible:ring-2 focus-visible:ring-primary-base"
                >
                  <RiSendPlane2Line className="size-4" aria-hidden />
                </button>
              )}
            </form>
            <span className="mx-0.5 h-5 w-px bg-stroke-soft-200" aria-hidden />
            <button
              ref={improveRef}
              type="button"
              onClick={() => onRequest("improve")}
              className={IDLE_ACTION_CLASS}
            >
              <RiSparkling2Line className="size-4" aria-hidden />
              Improve
            </button>
            <button
              type="button"
              onClick={() => onRequest("shorten")}
              className={`${IDLE_ACTION_CLASS} hidden sm:inline-flex`}
            >
              <RiScissorsLine className="size-4" aria-hidden />
              Shorten
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
