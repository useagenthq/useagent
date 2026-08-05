"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  RiCheckLine,
  RiFileCopyLine,
  RiRefreshLine,
  RiThumbDownLine,
  RiThumbUpLine,
} from "@remixicon/react";
import { cnExt as cn } from "@/utils/cn";

export interface StreamingSource {
  name: string;
  url: string;
  /** Optional avatar image URL; falls back to the source's initial letter. */
  icon?: string;
}

export interface StreamingTextProps {
  text: string;
  /** While true, the text types out char-by-char with a blinking caret. */
  active?: boolean;
  /** Collapsible "N sources" pill, revealed once the stream settles. */
  sources?: StreamingSource[];
  className?: string;
  /** Fired once the typed text first catches up to `text` while active. */
  onComplete?: () => void;
  /** Regenerate action in the settled action row. */
  onRegenerate?: () => void;
}

const CHARS_PER_TICK = 3;
const TICK_MS = 16;

function prefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Small stacked/list avatar: image when provided, else the initial letter. */
function SourceAvatar({
  source,
  className,
}: {
  source: StreamingSource;
  className?: string;
}) {
  if (source.icon) {
    // eslint-disable-next-line @next/next/no-img-element -- mock/remote favicons, no next/image loader
    return <img src={source.icon} alt="" className={cn("object-cover", className)} />;
  }
  return (
    <span
      className={cn(
        "flex items-center justify-center bg-bg-soft-200 text-[9px] font-semibold text-text-sub-600",
        className,
      )}
      aria-hidden
    >
      {source.name.charAt(0).toUpperCase()}
    </span>
  );
}

function ActionButton({
  label,
  onClick,
  active,
  children,
}: {
  label: string;
  onClick?: () => void;
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex size-7 items-center justify-center rounded-lg transition-colors duration-100",
        "hover:bg-bg-soft-200 hover:text-text-sub-600",
        active ? "text-text-strong-950" : "text-text-soft-400",
      )}
    >
      {children}
    </button>
  );
}

/**
 * Agent response text that types in while `active`, then settles into an action
 * row (copy / regenerate / feedback) and an optional expandable sources pill.
 * Ported from the beautiful-ui StreamingText demo onto AlignUI semantic tokens.
 */
export function StreamingText({
  text,
  active = false,
  sources = [],
  className,
  onComplete,
  onRegenerate,
}: StreamingTextProps) {
  const [shown, setShown] = useState(() => (active ? 0 : text.length));
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [feedback, setFeedback] = useState<"up" | "down" | null>(null);
  const completedRef = useRef(false);

  // Type the text out while active. `shown` is only ever advanced from inside
  // the interval callback — never set synchronously in the effect body — and
  // when the stream is inactive the render below shows the full text directly,
  // so no reset is needed on deactivation.
  useEffect(() => {
    if (!active) return;
    const reduced = prefersReducedMotion();
    const id = window.setInterval(() => {
      setShown((prev) => {
        if (reduced) return text.length;
        return prev >= text.length
          ? prev
          : Math.min(text.length, prev + CHARS_PER_TICK);
      });
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [active, text]);

  useEffect(() => {
    if (!active) {
      completedRef.current = false;
      return;
    }
    if (!completedRef.current && text.length > 0 && shown >= text.length) {
      completedRef.current = true;
      onComplete?.();
    }
  }, [active, shown, text.length, onComplete]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard denied — leave the icon unchanged.
    }
  }

  const visible = text.slice(0, Math.min(shown, text.length));
  const settled = !active;

  return (
    <div className={cn("w-full", className)}>
      <p className="text-paragraph-md leading-relaxed whitespace-pre-wrap text-text-strong-950">
        {visible}
        {active && (
          <span className="ai-caret ml-0.5 inline-block h-4 w-0.5 translate-y-0.5 rounded-full bg-text-strong-950 align-text-bottom" />
        )}
      </p>

      <div
        className={cn(
          "mt-2 flex items-center gap-0.5 transition-opacity duration-300",
          settled ? "opacity-100" : "pointer-events-none opacity-0",
        )}
        aria-hidden={!settled}
      >
        <ActionButton label={copied ? "Copied" : "Copy"} onClick={copy} active={copied}>
          {copied ? (
            <RiCheckLine className="size-4" aria-hidden />
          ) : (
            <RiFileCopyLine className="size-4" aria-hidden />
          )}
        </ActionButton>
        {onRegenerate && (
          <ActionButton label="Regenerate" onClick={onRegenerate}>
            <RiRefreshLine className="size-4" aria-hidden />
          </ActionButton>
        )}
        <ActionButton
          label="Good response"
          onClick={() => setFeedback((f) => (f === "up" ? null : "up"))}
          active={feedback === "up"}
        >
          <RiThumbUpLine className="size-4" aria-hidden />
        </ActionButton>
        <ActionButton
          label="Bad response"
          onClick={() => setFeedback((f) => (f === "down" ? null : "down"))}
          active={feedback === "down"}
        >
          <RiThumbDownLine className="size-4" aria-hidden />
        </ActionButton>

        {sources.length > 0 && (
          <button
            type="button"
            aria-expanded={sourcesOpen}
            onClick={() => setSourcesOpen((o) => !o)}
            className="ml-1.5 flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-left transition-colors duration-150 hover:bg-bg-soft-200"
          >
            <span className="flex -space-x-1.5">
              {sources.slice(0, 3).map((source) => (
                <SourceAvatar
                  key={source.url}
                  source={source}
                  className="size-4 rounded-full ring-2 ring-bg-weak-50"
                />
              ))}
            </span>
            <span className="text-paragraph-xs text-text-sub-600">
              {sources.length} {sources.length === 1 ? "source" : "sources"}
            </span>
          </button>
        )}
      </div>

      {sources.length > 0 && (
        <div
          className="grid transition-[grid-template-rows,opacity] duration-300 ease-out"
          style={{
            gridTemplateRows: settled && sourcesOpen ? "1fr" : "0fr",
            opacity: settled && sourcesOpen ? 1 : 0,
          }}
        >
          <div className="overflow-hidden">
            <div className="mt-1.5 flex flex-col rounded-xl border border-stroke-soft-200 bg-bg-white-0 p-1 shadow-regular-xs">
              {sources.map((source) => (
                <a
                  key={source.url}
                  href={source.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-2 rounded-lg px-1.5 py-1 text-paragraph-xs text-text-sub-600 transition-colors duration-150 hover:bg-bg-weak-50 hover:text-text-strong-950"
                >
                  <SourceAvatar source={source} className="size-4 shrink-0 rounded" />
                  <span className="truncate">{source.name}</span>
                  <span className="ml-auto shrink-0 font-mono text-paragraph-xs text-text-soft-400">
                    {hostOf(source.url)}
                  </span>
                </a>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
