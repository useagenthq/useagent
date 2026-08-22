"use client";

import { RiCodeSSlashLine, RiFileCopyLine } from "@remixicon/react";
import { AnimatePresence, MotionConfig, motion, useReducedMotion } from "motion/react";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from "react";

import { cx } from "@/utils/cx";

import {
  createSelectionActionsState,
  selectionActionsReducer,
  visibleSelectionText,
} from "./selection-actions-model";
import { SelectionActionsToolbar } from "./selection-actions-toolbar";

const DEFAULT_LEADING_TEXT = "Pistachio holds the top slot all weekend. ";
const DEFAULT_SELECTED_TEXT =
  "Churn it first thing Saturday so the batch has time to firm up before the afternoon rush.";
const DEFAULT_REWRITE =
  "Churn pistachio first thing Saturday so the batch has time to fully firm before the afternoon rush.";
const DEFAULT_SHORTENING = "Churn pistachio Saturday morning before the rush.";

const STREAM_CHUNK_SIZE = 3;
const STREAM_INTERVAL_MS = 16;
const THINKING_DELAY_MS = 450;

export interface SelectionActionsProps {
  leadingText?: string;
  selectedText?: string;
  rewriteText?: string;
  shortenedText?: string;
  initialResult?: boolean;
  className?: string;
  resolveRewrite?: (request: string, selectedText: string) => string | Promise<string>;
  onKeep?: (replacement: string) => void;
  onDiscard?: (selectedText: string) => void;
}

function wait(duration: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, duration));
}

export function SelectionActions({
  leadingText = DEFAULT_LEADING_TEXT,
  selectedText = DEFAULT_SELECTED_TEXT,
  rewriteText = DEFAULT_REWRITE,
  shortenedText = DEFAULT_SHORTENING,
  initialResult = true,
  className,
  resolveRewrite,
  onKeep,
  onDiscard,
}: SelectionActionsProps) {
  const reducedMotion = useReducedMotion();
  const [state, dispatch] = useReducer(selectionActionsReducer, undefined, () =>
    createSelectionActionsState(
      initialResult ? { phase: "result", request: "improve", replacement: rewriteText } : undefined,
    ),
  );
  const [prompt, setPrompt] = useState("");
  const [streamedCharacters, setStreamedCharacters] = useState(0);
  const [anchor, setAnchor] = useState({ x: 0, y: 0 });
  const [positioned, setPositioned] = useState(false);

  const hostRef = useRef<HTMLDivElement>(null);
  const selectionRef = useRef<HTMLSpanElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const improveRef = useRef<HTMLButtonElement>(null);
  const requestIdRef = useRef(0);
  const previousPhaseRef = useRef(state.phase);

  const displayText =
    state.phase === "streaming" && state.replacement
      ? state.replacement.slice(0, streamedCharacters)
      : visibleSelectionText(state, selectedText);
  const toolbarVisible = state.phase !== "accepted";

  const placeToolbar = useCallback(() => {
    const host = hostRef.current;
    const selection = selectionRef.current;
    const toolbar = toolbarRef.current;
    if (!(host && selection && toolbar)) return;

    const hostBounds = host.getBoundingClientRect();
    const selectionBounds = selection.getBoundingClientRect();
    const selectionLines = Array.from(selection.getClientRects()).filter((rect) => rect.width > 0);
    const finalLine = selectionLines.at(-1);
    if (!finalLine) return;

    const halfToolbar = toolbar.offsetWidth / 2;
    const idealX = selectionBounds.left - hostBounds.left + selectionBounds.width / 2;
    const minimumX = halfToolbar;
    const maximumX = hostBounds.width - halfToolbar;

    setAnchor({
      x:
        maximumX < minimumX ? hostBounds.width / 2 : Math.min(maximumX, Math.max(minimumX, idealX)),
      y: finalLine.bottom - hostBounds.top + 12,
    });
    setPositioned(true);
  }, []);

  useLayoutEffect(() => {
    placeToolbar();
  }, [displayText, placeToolbar, state.phase]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const observer = new ResizeObserver(placeToolbar);
    observer.observe(host);
    window.addEventListener("resize", placeToolbar);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", placeToolbar);
    };
  }, [placeToolbar]);

  useEffect(() => {
    if (state.phase !== "streaming" || !state.replacement) return;

    setStreamedCharacters(reducedMotion ? state.replacement.length : 0);
    if (reducedMotion) {
      dispatch({ type: "complete" });
      return;
    }

    const interval = window.setInterval(() => {
      setStreamedCharacters((current) => {
        const next = Math.min(state.replacement?.length ?? 0, current + STREAM_CHUNK_SIZE);
        return next;
      });
    }, STREAM_INTERVAL_MS);

    return () => window.clearInterval(interval);
  }, [reducedMotion, state.phase, state.replacement]);

  useEffect(() => {
    if (
      state.phase === "streaming" &&
      state.replacement &&
      streamedCharacters >= state.replacement.length
    ) {
      dispatch({ type: "complete" });
    }
  }, [state.phase, state.replacement, streamedCharacters]);

  useEffect(() => {
    const previousPhase = previousPhaseRef.current;
    previousPhaseRef.current = state.phase;

    if (state.phase === "result" && previousPhase === "streaming") {
      keepRef.current?.focus({ preventScroll: true });
    } else if (state.phase === "idle" && previousPhase === "result") {
      improveRef.current?.focus({ preventScroll: true });
    }
  }, [state.phase]);

  useEffect(
    () => () => {
      requestIdRef.current += 1;
    },
    [],
  );

  async function run(request: string, retrying = false) {
    const normalizedRequest = request.trim() || "improve";
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    dispatch(retrying ? { type: "retry" } : { type: "request", request: normalizedRequest });

    const fallback = normalizedRequest === "shorten" ? shortenedText : rewriteText;
    try {
      const replacementPromise = Promise.resolve(
        resolveRewrite?.(normalizedRequest, selectedText) ?? fallback,
      );
      const [replacement] = await Promise.all([
        replacementPromise,
        wait(reducedMotion ? 0 : THINKING_DELAY_MS),
      ]);

      if (requestIdRef.current !== requestId) return;
      if (!replacement.trim()) {
        dispatch({ type: "reject" });
        return;
      }
      dispatch({ type: "stream", replacement });
    } catch {
      if (requestIdRef.current === requestId) dispatch({ type: "reject" });
    }
  }

  function keep() {
    if (!state.replacement) return;
    dispatch({ type: "keep" });
    onKeep?.(state.replacement);
  }

  function discard() {
    requestIdRef.current += 1;
    setPrompt("");
    dispatch({ type: "discard" });
    onDiscard?.(selectedText);
  }

  function retry() {
    if (!state.request) return;
    void run(state.request, true);
  }

  function submitPrompt() {
    if (prompt.trim()) void run(prompt);
  }

  function handleKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Escape" || state.phase === "accepted") return;
    event.preventDefault();
    discard();
  }

  return (
    <MotionConfig reducedMotion="user" transition={{ duration: 0.22 }}>
      <div
        className={cx(
          "relative flex min-h-[272px] w-full items-center overflow-hidden rounded-[24px] border border-[#303237] bg-[#18191b] px-5 py-16 shadow-card sm:px-14 lg:px-[72px]",
          className,
        )}
      >
        <div className="absolute top-6 right-6 hidden items-center gap-2 sm:flex" aria-hidden>
          <span className="inline-flex size-11 items-center justify-center rounded-[18px] border border-[#383a3f] bg-[#202124] text-text-secondary shadow-card">
            <RiFileCopyLine className="size-5" />
          </span>
          <span className="inline-flex size-11 items-center justify-center rounded-[18px] border border-[#383a3f] bg-[#202124] text-text-secondary shadow-card">
            <RiCodeSSlashLine className="size-5" />
          </span>
        </div>
        <div ref={hostRef} className="relative mx-auto w-full max-w-[770px] pb-14">
          <p className="text-[24px] leading-[1.45] text-text-primary">
            {leadingText}
            <span
              ref={selectionRef}
              className={cx(
                "box-decoration-clone rounded-[3px] transition-[color,background-color] duration-200",
                state.phase === "accepted"
                  ? "text-text-primary"
                  : "bg-[#2a384c] text-text-primary",
              )}
            >
              {displayText}
              {state.phase === "streaming" && (
                <span className="ai-caret ml-0.5 inline-block h-4 w-px translate-y-0.5 bg-current align-text-bottom" />
              )}
            </span>
          </p>

          <AnimatePresence initial={false}>
            {toolbarVisible && (
              <motion.div
                className="absolute top-0 left-0 z-10"
                initial={{ opacity: 0 }}
                animate={{ opacity: positioned ? 1 : 0 }}
                exit={{ opacity: 0 }}
                style={{
                  pointerEvents: positioned ? "auto" : "none",
                  transform: `translate3d(${anchor.x}px, ${anchor.y}px, 0) translateX(-50%)`,
                  transition: reducedMotion
                    ? undefined
                    : "transform 320ms cubic-bezier(0.77,0,0.175,1), opacity 180ms ease-out",
                }}
              >
                <SelectionActionsToolbar
                  phase={state.phase}
                  request={state.request}
                  prompt={prompt}
                  reducedMotion={reducedMotion}
                  toolbarRef={toolbarRef}
                  keepRef={keepRef}
                  improveRef={improveRef}
                  onKeyDown={handleKeyboard}
                  onKeep={keep}
                  onDiscard={discard}
                  onRetry={retry}
                  onPromptChange={setPrompt}
                  onPromptSubmit={submitPrompt}
                  onRequest={(request) => void run(request)}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </MotionConfig>
  );
}
