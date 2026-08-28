// Ported from the beautiful-ui Prompt Bar demo (upstream refresh, Aug 2026;
// hardcoded → parameterized) onto our semantic tokens and Remixicon. A composer
// with real controls: an attachment/source menu on "+" and "@", "/" commands, a
// model picker popover, dictation, and send. Both upstream variants are kept:
// "rounded" (card radius) and "pill" (full radius). The upstream glimm canvas
// sweep and self-running demo loop are intentionally not ported.
"use client";

import {
  RiAddLine,
  RiArrowDownSLine,
  RiArrowUpLine,
  RiCheckLine,
  RiCloseLine,
  RiFile3Line,
  RiMicLine,
} from "@remixicon/react";
import { useReducedMotion } from "motion/react";
import type { ComponentType } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cx } from "@/utils/cx";

type IconComponent = ComponentType<{
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
}>;

export interface PromptSource {
  key: string;
  name: string;
  desc: string;
  icon: IconComponent;
  /** Picking this row adds a file chip instead of inserting an @mention. */
  attach?: boolean;
  /** Row carries a Connect / Connected affordance. */
  connect?: boolean;
}

export interface PromptCommand {
  key: string;
  /** Including the leading slash, e.g. "/review". */
  name: string;
  desc: string;
}

export interface PromptModel {
  key: string;
  name: string;
  /** Short trailing tag in the picker, e.g. "Default" or "Fast". */
  tag: string;
}

export interface PromptBarProps {
  variant?: "rounded" | "pill";
  placeholder?: string;
  sources: PromptSource[];
  commands: PromptCommand[];
  models: PromptModel[];
  /** Files the attach row cycles through when picked. */
  attachPool?: string[];
  /** Text that lands as the transcript shortly after dictation starts. */
  dictationSample?: string;
  onSend?: (text: string) => void;
  className?: string;
}

/** The last @word or /word being typed, if any. */
function parseToken(draft: string): { kind: "at" | "slash"; query: string; start: number } | null {
  const match = /(^|\s)([@/])([\w-]*)$/.exec(draft);
  if (!match) return null;
  return {
    kind: match[2] === "@" ? "at" : "slash",
    query: match[3].toLowerCase(),
    start: match.index + match[1].length,
  };
}

const POP_IN = "prompt-pop-in 180ms cubic-bezier(0.23,1,0.32,1) both";
const KEYFRAMES =
  "@keyframes prompt-pop-in{from{opacity:0;transform:scale(0.96)}to{opacity:1;transform:scale(1)}}" +
  "@keyframes prompt-eq-bounce{0%,100%{transform:scaleY(0.4)}50%{transform:scaleY(1)}}";

const GLIDE =
  "top 220ms cubic-bezier(0.23,1,0.32,1), height 220ms cubic-bezier(0.23,1,0.32,1), opacity 150ms ease";

export function PromptBar({
  variant = "rounded",
  placeholder,
  sources,
  commands,
  models,
  attachPool = [],
  dictationSample,
  onSend,
  className,
}: PromptBarProps) {
  const pill = variant === "pill";
  const reducedMotion = useReducedMotion();
  const [draft, setDraft] = useState("");
  const [dismissed, setDismissed] = useState(false);
  const [plusOpen, setPlusOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [model, setModel] = useState(models[0]);
  const [attachments, setAttachments] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const [active, setActive] = useState(0);
  const [listening, setListening] = useState(false);
  /** Wrapped text moves above the controls onto its own row. */
  const [wide, setWide] = useState(false);
  const [rowBox, setRowBox] = useState<{ top: number; height: number } | null>(null);
  const [engaged, setEngaged] = useState(false);
  const [modelBox, setModelBox] = useState<{ top: number; height: number } | null>(null);
  const [modelHovered, setModelHovered] = useState<number | null>(null);
  const [modelMenuLeft, setModelMenuLeft] = useState(0);
  const [modelMenuBottom, setModelMenuBottom] = useState(0);
  const anchorRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const modelRef = useRef<HTMLButtonElement>(null);
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const modelRowRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const token = dismissed ? null : parseToken(draft);
  const menu: "at" | "slash" | null = plusOpen ? "at" : (token?.kind ?? null);
  const query = plusOpen ? "" : (token?.query ?? "");

  const rows: { key: string; name: string; desc: string }[] =
    menu === "at"
      ? sources.filter((s) => s.name.toLowerCase().includes(query))
      : menu === "slash"
        ? commands.filter((c) => c.name.slice(1).startsWith(query))
        : [];

  useEffect(() => {
    setActive(0);
    setEngaged(false);
  }, [menu, query]);

  /* A single highlight glides to the active row instead of each row toggling
   * its own background. */
  useLayoutEffect(() => {
    const target = rowRefs.current[active];
    if (target) setRowBox({ top: target.offsetTop, height: target.offsetHeight });
  }, [menu, query, active, connected, rows.length]);

  /* Same gliding highlight in the model menu - floats to the hovered row,
   * falling back to the currently selected model. */
  const modelIndex = models.findIndex((m) => m.key === model.key);
  useLayoutEffect(() => {
    if (!modelOpen) return;
    const target = modelRowRefs.current[modelHovered ?? modelIndex];
    if (target) setModelBox({ top: target.offsetTop, height: target.offsetHeight });
  }, [modelOpen, modelHovered, modelIndex]);

  /* The menu sits outside the clipped composer, so align it to the model
   * trigger by measurement instead of pinning it to the far-right edge. */
  useLayoutEffect(() => {
    if (!modelOpen || !anchorRef.current || !modelRef.current) return;
    const anchorRect = anchorRef.current.getBoundingClientRect();
    const triggerRect = modelRef.current.getBoundingClientRect();
    setModelMenuLeft(
      Math.max(0, Math.min(triggerRect.left - anchorRect.left, anchorRect.width - 208)),
    );
    setModelMenuBottom(anchorRect.bottom - triggerRect.top + 8);
  }, [modelOpen, wide, model.name]);

  useEffect(() => {
    if (!modelOpen) setModelHovered(null);
  }, [modelOpen]);

  /* Dictation resolves after a beat, like a real transcript landing. */
  useEffect(() => {
    if (!listening || !dictationSample) return;
    const t = setTimeout(() => {
      setDraft((current) => (current ? `${current.trimEnd()} ${dictationSample}` : dictationSample));
      setListening(false);
      inputRef.current?.focus();
    }, 2200);
    return () => clearTimeout(t);
  }, [listening, dictationSample]);

  /* Move wrapped text above the controls, then grow to a compact maximum. */
  useLayoutEffect(() => {
    const input = inputRef.current;
    const controls = controlsRef.current;
    const measure = measureRef.current;
    const modelButton = modelRef.current;
    if (!input || !controls || !measure || !modelButton) return;

    const fixedControlsWidth = 28 * 3 + modelButton.offsetWidth;
    const inlineGaps = 4 * 4;
    const inlineInputWidth = controls.clientWidth - fixedControlsWidth - inlineGaps;
    const needsFullWidth = draft.includes("\n") || measure.offsetWidth + 8 > inlineInputWidth;
    if (needsFullWidth !== wide) setWide(needsFullWidth);

    input.style.height = "0px";
    const contentHeight = input.scrollHeight;
    input.style.height = `${Math.min(Math.max(contentHeight, 28), 100)}px`;
    input.style.overflowY = contentHeight > 100 ? "auto" : "hidden";
  }, [draft, wide]);

  /* Clicking anywhere outside the composer closes the open menus. */
  useEffect(() => {
    if (!modelOpen && !plusOpen) return;
    const close = (event: PointerEvent) => {
      if (!(event.target as Element).closest("[data-prompt-bar]")) {
        setModelOpen(false);
        setPlusOpen(false);
      }
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [modelOpen, plusOpen]);

  const closeMenus = () => {
    setPlusOpen(false);
    setModelOpen(false);
  };

  const pick = (row: { key: string; name: string }) => {
    const source = sources.find((s) => s.key === row.key);
    if (source?.attach) {
      if (attachPool.length > 0) {
        setAttachments((current) => [...current, attachPool[current.length % attachPool.length]]);
      }
      if (token) setDraft(draft.slice(0, token.start));
    } else if (menu === "at") {
      setDraft(`${token ? draft.slice(0, token.start) : draft}@${row.name} `);
    } else {
      setDraft(`${token ? draft.slice(0, token.start) : draft}${row.name} `);
    }
    setPlusOpen(false);
    setDismissed(false);
    inputRef.current?.focus();
  };

  const canSend = draft.trim().length > 0 || attachments.length > 0;
  const send = () => {
    if (!canSend) return;
    onSend?.(draft.trim());
    setDraft("");
    setAttachments([]);
    closeMenus();
  };

  const controlRadius = pill ? "rounded-full" : "rounded-lg";

  return (
    <div data-prompt-bar className={cx("w-full", className)}>
      <style>{KEYFRAMES}</style>
      {/* The composer is the anchor - menus grow up from its top edge. */}
      <div ref={anchorRef} className="relative">
        {/* @ / slash menu */}
        {menu && (
          <div
            onMouseLeave={() => setEngaged(false)}
            className="absolute inset-x-0 bottom-full z-10 mb-2 rounded-xl border border-border-button-default bg-background-primary-default p-1 shadow-dropdown"
            style={
              reducedMotion ? undefined : { animation: POP_IN, transformOrigin: "bottom center" }
            }
          >
            {/* Single gliding highlight - appears once a row is hovered. */}
            <span
              aria-hidden
              className="pointer-events-none absolute inset-x-1 rounded-md bg-background-primary-hover"
              style={{
                top: rowBox?.top ?? 0,
                height: rowBox?.height ?? 0,
                opacity: rowBox && engaged && rows.length > 0 ? 1 : 0,
                transition: reducedMotion ? undefined : GLIDE,
              }}
            />
            {rows.map((row, i) => {
              const source = menu === "at" ? sources.find((s) => s.key === row.key) : undefined;
              const SourceIcon = source?.icon;
              return (
                <button
                  key={row.key}
                  type="button"
                  ref={(el) => {
                    rowRefs.current[i] = el;
                  }}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => {
                    setActive(i);
                    setEngaged(true);
                  }}
                  onClick={() => pick(row)}
                  className="relative z-10 flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left"
                >
                  {SourceIcon && (
                    <span className="flex size-5 shrink-0 items-center justify-center text-text-secondary">
                      <SourceIcon className="size-4" aria-hidden />
                    </span>
                  )}
                  <span className="shrink-0 text-body-2-medium text-text-primary">{row.name}</span>
                  <span className="min-w-0 flex-1 truncate text-caption-1-regular text-text-tertiary">
                    {row.desc}
                  </span>
                  {source?.connect && (
                    <span
                      role="button"
                      tabIndex={-1}
                      onClick={(event) => {
                        event.stopPropagation();
                        setConnected((current) => !current);
                      }}
                      className={cx(
                        "shrink-0 text-caption-1-medium transition-colors duration-100",
                        connected ? "text-lime-600" : "text-accent-500 hover:underline",
                      )}
                    >
                      {connected ? "Connected" : "Connect"}
                    </span>
                  )}
                </button>
              );
            })}
            {rows.length === 0 && (
              <div className="flex h-8 items-center px-2 text-caption-1-regular text-text-tertiary">
                No matches for "{query}"
              </div>
            )}
            <div className="mt-1 border-t border-border-button-default px-2 pt-1.5 pb-1 text-caption-1-regular text-text-tertiary">
              {menu === "at" ? "Type to search sources & files" : "Type to search commands"}
            </div>
          </div>
        )}

        {/* Model menu */}
        {modelOpen && (
          <div
            onMouseLeave={() => setModelHovered(null)}
            className="absolute z-10 w-52 rounded-xl border border-border-button-default bg-background-primary-default p-1 shadow-dropdown"
            style={{
              left: modelMenuLeft,
              bottom: modelMenuBottom,
              ...(reducedMotion ? {} : { animation: POP_IN, transformOrigin: "bottom left" }),
            }}
          >
            <span
              aria-hidden
              className="pointer-events-none absolute inset-x-1 rounded-md bg-background-primary-hover"
              style={{
                top: modelBox?.top ?? 0,
                height: modelBox?.height ?? 0,
                opacity: modelBox && modelHovered !== null ? 1 : 0,
                transition: reducedMotion ? undefined : GLIDE,
              }}
            />
            {models.map((m, i) => (
              <button
                key={m.key}
                type="button"
                ref={(el) => {
                  modelRowRefs.current[i] = el;
                }}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setModelHovered(i)}
                onClick={() => {
                  setModel(m);
                  setModelOpen(false);
                  inputRef.current?.focus();
                }}
                className="relative z-10 flex h-8 w-full items-center gap-2 rounded-md px-2 text-left"
              >
                <span className="min-w-0 flex-1 truncate text-body-2-medium text-text-primary">
                  {m.name}
                </span>
                <span className="shrink-0 text-caption-1-regular text-text-tertiary">{m.tag}</span>
                <RiCheckLine
                  className={cx(
                    "size-3.5 shrink-0 text-text-primary",
                    m.key !== model.key && "invisible",
                  )}
                  aria-hidden
                />
              </button>
            ))}
          </div>
        )}

        {/* Composer */}
        <div
          className={cx(
            "relative isolate flex flex-col gap-1.5 overflow-hidden border border-border-button-default bg-background-primary-default p-1.5 shadow-card transition-[border-color,border-radius] duration-150 focus-within:border-border-button-hover",
            pill ? (attachments.length > 0 || wide ? "rounded-3xl" : "rounded-full") : "rounded-2xl",
          )}
        >
          <span
            ref={measureRef}
            aria-hidden="true"
            className="pointer-events-none invisible absolute text-body-2-regular whitespace-pre"
          >
            {draft}
          </span>

          {attachments.length > 0 && (
            <div className={cx("flex flex-wrap gap-1.5 pt-0.5", pill ? "px-1" : "px-0.5")}>
              {attachments.map((file, i) => (
                <span
                  key={`${file}-${i}`}
                  className={cx(
                    "flex h-6.5 items-center gap-1.5 bg-background-secondary-default py-1 pr-1 pl-1.5 text-caption-1-regular text-text-secondary",
                    pill ? "rounded-full" : "rounded-md",
                  )}
                  style={reducedMotion ? undefined : { animation: POP_IN }}
                >
                  <RiFile3Line className="size-3 shrink-0" aria-hidden />
                  <span className="max-w-36 truncate">{file}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${file}`}
                    onClick={() => setAttachments((current) => current.filter((_, j) => j !== i))}
                    className={cx(
                      "-my-1 flex size-6 items-center justify-center text-text-tertiary transition-colors duration-100 hover:bg-background-primary-hover hover:text-text-primary",
                      pill ? "rounded-full" : "rounded-[5px]",
                    )}
                  >
                    <RiCloseLine className="size-3" aria-hidden />
                  </button>
                </span>
              ))}
            </div>
          )}

          <div
            ref={controlsRef}
            className={cx(
              "grid items-end gap-x-1 gap-y-1.5",
              wide
                ? "grid-cols-[28px_auto_minmax(0,1fr)_28px_28px]"
                : "grid-cols-[28px_minmax(0,1fr)_auto_28px_28px]",
            )}
          >
            <button
              type="button"
              aria-label="Add attachments and sources"
              aria-expanded={plusOpen}
              onClick={() => {
                setModelOpen(false);
                setPlusOpen((current) => !current);
                inputRef.current?.focus();
              }}
              className={cx(
                "flex size-7 shrink-0 items-center justify-center justify-self-start text-text-tertiary transition-[background-color,color,transform] duration-150 hover:bg-background-primary-hover hover:text-text-primary active:scale-[0.94]",
                controlRadius,
                plusOpen && "bg-background-primary-hover text-text-primary",
                wide ? "col-start-1 row-start-2" : "col-start-1 row-start-1",
              )}
            >
              <RiAddLine className="size-4" aria-hidden />
            </button>

            <textarea
              ref={inputRef}
              rows={1}
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                setDismissed(false);
                setPlusOpen(false);
              }}
              onKeyDown={(event) => {
                if (menu && rows.length > 0) {
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    setEngaged(true);
                    setActive(
                      (current) =>
                        (current + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length,
                    );
                    return;
                  }
                  if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
                    event.preventDefault();
                    pick(rows[active]);
                    return;
                  }
                }
                if (event.key === "Escape") {
                  setDismissed(true);
                  closeMenus();
                  return;
                }
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  send();
                }
              }}
              placeholder={listening ? "Listening..." : (placeholder ?? "Write a message...")}
              aria-label="Prompt"
              className={cx(
                "min-h-7 w-full min-w-0 resize-none bg-transparent px-1 py-[5px] text-body-2-regular text-text-primary outline-none [overflow-wrap:anywhere] placeholder:text-text-placeholder",
                wide ? "col-span-full col-start-1 row-start-1" : "col-start-2 row-start-1",
              )}
            />

            {/* Model picker */}
            <button
              ref={modelRef}
              type="button"
              aria-expanded={modelOpen}
              aria-label="Choose model"
              onClick={() => {
                setPlusOpen(false);
                setModelOpen((current) => !current);
              }}
              className={cx(
                "flex h-7 shrink-0 items-center gap-1 px-1.5 text-caption-1-medium text-text-secondary transition-colors duration-150 hover:bg-background-primary-hover hover:text-text-primary",
                controlRadius,
                wide ? "col-start-2 row-start-2 justify-self-start" : "col-start-3 row-start-1",
              )}
            >
              {model.name}
              <RiArrowDownSLine className="size-3 text-text-tertiary" aria-hidden />
            </button>

            {/* Dictation */}
            <button
              type="button"
              aria-label={listening ? "Stop dictation" : "Start dictation"}
              aria-pressed={listening}
              onClick={() => setListening((current) => !current)}
              className={cx(
                "flex size-7 shrink-0 items-center justify-center transition-[background-color,color,transform] duration-150 active:scale-[0.94]",
                controlRadius,
                listening
                  ? "bg-accent-500/10 text-accent-500"
                  : "text-text-tertiary hover:bg-background-primary-hover hover:text-text-primary",
                wide ? "col-start-4 row-start-2" : "col-start-4 row-start-1",
              )}
            >
              {listening ? (
                <span className="flex h-3.5 items-center gap-[2.5px]">
                  {[0, 1, 2].map((i) => (
                    <span
                      key={i}
                      className="h-full w-[2.5px] rounded-full bg-current"
                      style={
                        reducedMotion
                          ? undefined
                          : { animation: `prompt-eq-bounce 900ms ease-in-out ${i * 150}ms infinite` }
                      }
                    />
                  ))}
                </span>
              ) : (
                <RiMicLine className="size-4" aria-hidden />
              )}
            </button>

            {/* Send */}
            <button
              type="button"
              aria-label="Send"
              disabled={!canSend}
              onClick={send}
              className={cx(
                "flex size-7 shrink-0 items-center justify-center transition-[background-color,color,transform] duration-200 enabled:active:scale-[0.94]",
                controlRadius,
                canSend
                  ? "bg-button-primary text-text-white"
                  : "bg-background-secondary-default text-text-tertiary",
                wide ? "col-start-5 row-start-2" : "col-start-5 row-start-1",
              )}
            >
              <RiArrowUpLine className="size-4" aria-hidden />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
