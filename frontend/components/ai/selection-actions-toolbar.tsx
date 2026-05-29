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
  "inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 text-body-2-regular text-text-secondary outline-none transition-[background-color,color,transform] hover:bg-background-secondary-hover hover:text-text-primary active:scale-[0.97] focus-visible:bg-background-secondary-hover focus-visible:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring";

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
  const errorVisible = phase === "error";

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
      className={`flex h-10 max-w-[calc(100vw-2rem)] items-center justify-center overflow-hidden rounded-full p-1 [box-shadow:0_18px_40px_-14px_rgb(0_0_0/0.4),0_0_0_1px_var(--color-border-button-hover)] ${
        resultVisible || errorVisible
          ? "bg-[#202226] text-white"
          : "bg-background-secondary-default text-text-primary"
      }`}
    >
      <AnimatePresence initial={false} mode="popLayout">
        {phase === "thinking" || phase === "streaming" ? (
          <motion.div
            key="busy"
            initial={reducedMotion ? false : { opacity: 0, x: 5 }}
            animate={{ opacity: 1, x: 0 }}
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, x: -5 }}
            className="inline-flex h-8 items-center gap-2 whitespace-nowrap px-3 text-body-2-regular text-text-secondary"
            aria-live="polite"
          >
            <span className="size-3.5 animate-spin rounded-full border-2 border-border-button-hover border-t-text-secondary motion-reduce:animate-none" />
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
              className="inline-flex h-8 items-center gap-1.5 rounded-full bg-background-primary-default px-3.5 text-body-regular text-text-primary shadow-card outline-none transition-transform active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-border-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-[#202226]"
            >
              <RiCheckLine className="size-4" aria-hidden />
              Keep
            </button>
            <button
              type="button"
              onClick={onDiscard}
              className="inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-body-regular text-white outline-none transition-[background-color,transform] hover:bg-white/10 active:scale-[0.97] focus-visible:bg-white/10 focus-visible:ring-2 focus-visible:ring-border-focus-ring"
            >
              <RiCloseLine className="size-4" aria-hidden />
              Discard
            </button>
            <span className="mx-1 h-5 w-px bg-white/15" aria-hidden />
            <button
              type="button"
              aria-label="Regenerate rewrite"
              onClick={onRetry}
              className="flex size-8 items-center justify-center rounded-full text-white/70 outline-none transition-[background-color,color,transform] hover:bg-white/10 hover:text-white active:scale-[0.96] focus-visible:bg-white/10 focus-visible:text-white focus-visible:ring-2 focus-visible:ring-border-focus-ring"
            >
              <RiRefreshLine className="size-5" aria-hidden />
            </button>
          </motion.div>
        ) : errorVisible ? (
          <motion.div
            key="error"
            initial={reducedMotion ? false : { opacity: 0, x: 6 }}
            animate={{ opacity: 1, x: 0 }}
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, x: -6 }}
            className="flex items-center gap-0.5"
            aria-live="polite"
          >
            <span className="px-2.5 text-body-2-regular text-white">Rewrite failed</span>
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex h-8 items-center gap-1.5 rounded-full bg-background-primary-default px-3 text-body-2-regular text-text-primary outline-none transition-transform active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-border-focus-ring"
            >
              <RiRefreshLine className="size-4" aria-hidden />
              Retry
            </button>
            <button
              type="button"
              onClick={onDiscard}
              className="inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 text-body-2-regular text-white outline-none transition-[background-color,transform] hover:bg-white/10 active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-border-focus-ring"
            >
              <RiCloseLine className="size-4" aria-hidden />
              Discard
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
                className="h-8 w-24 bg-transparent px-3 text-body-2-regular text-text-primary outline-none placeholder:text-text-placeholder sm:w-32"
              />
              {prompt.trim() && (
                <button
                  type="submit"
                  aria-label="Send edit instruction"
                  className="mr-0.5 flex size-7 items-center justify-center rounded-full bg-button-primary text-text-white outline-none transition-transform active:scale-[0.96] focus-visible:ring-2 focus-visible:ring-border-focus-ring"
                >
                  <RiSendPlane2Line className="size-4" aria-hidden />
                </button>
              )}
            </form>
            <span className="mx-0.5 h-5 w-px bg-border-button-default" aria-hidden />
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
