"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

/* ─────────────────────────────────────────────────────────
 * THINKING — expandable agent trace, four variants
 *
 *   Steps      step list with spinner → muted checks
 *   Reasoning  prose reasoning that expands, then settles
 *   Search     web-search trace: query + sources read
 *   Coding     tool trace: files read, edits, commands
 *
 * The trace runs once, settles, and remains expandable.
 * ───────────────────────────────────────────────────────── */

const STAGES = [800, 600, 1800, 2600, 1600];

function useSequence(steps: number[]) {
  const [stage, setStage] = useState(0);
  useEffect(() => {
    if (stage >= steps.length - 1) return;
    const t = setTimeout(() => setStage((s) => s + 1), steps[stage]);
    return () => clearTimeout(t);
  }, [stage, steps]);
  return stage;
}

type Row = {
  primary: string;
  secondary?: string;
  mono?: boolean;
  add?: number;
  del?: number;
  href?: string;
};

const VARIANTS: Record<
  string,
  { active: string; done: string; rows: Row[]; query?: string }
> = {
  Steps: {
    active: "Thinking",
    done: "Thought for 4 seconds",
    rows: [
      { primary: "Reading flavor briefs" },
      { primary: "Scanning supplier lists" },
      { primary: "Comparing tasting notes", secondary: "6 flavors" },
      { primary: "Writing the scoop report" },
    ],
  },
  Reasoning: {
    active: "Thinking",
    done: "Thought for 4 seconds",
    rows: [
      { primary: "Summer demand spikes for stone-fruit flavors — peach and apricot lead." },
      { primary: "I should check cone inventory before promoting a waffle-bowl special." },
    ],
  },
  Search: {
    active: "Searching the web",
    done: "Searched the web",
    query: "best waffle cone supplier",
    rows: [
      { primary: "Joy Cone", secondary: "joycone.com", href: "https://joycone.com/fs_products/waffle-cones/" },
      { primary: "WebstaurantStore", secondary: "webstaurantstore.com", href: "https://www.webstaurantstore.com/ice-cream-shop-supplies.html" },
      { primary: "The Konery", secondary: "thekonery.com", href: "https://www.thekonery.com/" },
    ],
  },
  Coding: {
    active: "Running tools",
    done: "Ran 3 tools",
    rows: [
      { primary: "Read", secondary: "flavors.ts", mono: true },
      { primary: "Edit", secondary: "ChurnSchedule.tsx", mono: true, add: 74, del: 41 },
      { primary: "Run", secondary: "npm run freeze", mono: true },
    ],
  },
};

function Dot({ tone }: { tone: string }) {
  return (
    <span className={`flex size-3.5 shrink-0 items-center justify-center rounded-full text-white ${tone}`}>
      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
        <circle cx="12" cy="12" r="9" />
        <path d="M3.5 12h17M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
      </svg>
    </span>
  );
}

const TONES = ["bg-accent", "bg-orange", "bg-green"];

export default function ThinkingState({ variant = "Steps" }: { variant?: string }) {
  const stage = useSequence(STAGES);
  const [manualExpanded, setManualExpanded] = useState<boolean | null>(null);
  const [selectedTool, setSelectedTool] = useState<string | null>(null);
  const v = VARIANTS[variant] ?? VARIANTS.Steps;
  const autoExpanded = stage >= 1 && stage < 4;
  const expanded = manualExpanded ?? autoExpanded;
  const working = stage < 3;
  const visible = stage < 2 ? 0 : stage === 2 ? Math.min(2, v.rows.length) : v.rows.length;
  const traceRef = useRef<HTMLDivElement>(null);
  const [lineHeight, setLineHeight] = useState(0);
  useLayoutEffect(() => {
    if (traceRef.current) setLineHeight(traceRef.current.offsetHeight);
  }, [visible, expanded, variant, stage]);

  return (
    <div key={variant} className="flex min-h-[176px] w-full max-w-95 flex-col">
      {/* header — shared across variants */}
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setManualExpanded((current) => !(current ?? autoExpanded))}
        className="-mx-1.5 flex w-fit items-center gap-2 rounded-control px-1.5 py-1
          transition-colors duration-100 hover:bg-hover-2"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill={working ? "var(--ink-2)" : "var(--ink-3)"}>
          <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" />
        </svg>
        {working ? (
          <span
            className="bg-clip-text text-[13px] font-medium whitespace-nowrap text-transparent"
            style={{
              backgroundImage:
                "linear-gradient(90deg, var(--ink-3) 35%, var(--ink) 50%, var(--ink-3) 65%)",
              backgroundSize: "200% 100%",
              animation: "shimmer-text 1.4s linear infinite",
            }}
          >
            {v.active}
          </span>
        ) : (
          <span
            className="text-[13px] font-medium whitespace-nowrap text-ink-2"
            style={{ animation: "fade-in 350ms ease-out both" }}
          >
            {v.done}
          </span>
        )}
        <svg
          width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--ink-3)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
          className="transition-transform duration-300"
          style={{ transform: expanded ? "rotate(180deg)" : "rotate(0)" }}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {/* expandable trace */}
      <div
        className="grid transition-[grid-template-rows,opacity] duration-400"
        style={{
          gridTemplateRows: expanded ? "1fr" : "0fr",
          opacity: expanded ? 1 : 0,
          transitionTimingFunction: "cubic-bezier(0.23, 1, 0.32, 1)",
        }}
      >
        <div className="overflow-hidden">
          <div className="relative mt-1 ml-[5px] pl-4">
            <span
              aria-hidden
              className="absolute left-[3px] w-px bg-line"
              style={{ top: -8, height: lineHeight ? lineHeight - 2 : 0, transition: "height 500ms cubic-bezier(0.23,1,0.32,1)" }}
            />
            <div ref={traceRef} className="flex flex-col gap-1 py-1">
            {v.query && (
              <div className="flex h-6 items-center gap-2 px-1.5" style={{ animation: expanded ? "fade-up 300ms cubic-bezier(0.23,1,0.32,1) both" : undefined }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--ink-3)" strokeWidth="2" strokeLinecap="round" className="shrink-0">
                  <circle cx="11" cy="11" r="7" />
                  <path d="M21 21l-4.3-4.3" />
                </svg>
                <span className="text-[12.5px] text-ink-2">{v.query}</span>
              </div>
            )}
            {v.rows.slice(0, visible).map((row, i) => {
              const content = (
                <>
                {variant === "Search" && <Dot tone={TONES[i % 3]} />}
                {variant === "Steps" && (
                  i < visible - 1 || !working ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--ink-3)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                  ) : (
                    <span className="size-3 shrink-0 rounded-full border-[1.5px] border-line-strong border-t-ink-2" style={{ animation: "spin 700ms linear infinite" }} />
                  )
                )}
                <span className={`min-w-0 truncate text-[12.5px] ${variant === "Reasoning" ? "whitespace-normal leading-relaxed text-ink-2" : "font-medium text-ink"} ${variant === "Search" ? "animated-underline" : ""}`}>
                  {row.primary}
                </span>
                {row.secondary && (
                  <span className={`shrink-0 text-[11.5px] text-ink-3 ${row.mono ? "font-mono" : ""}`}>
                    {row.secondary}
                  </span>
                )}
                {row.add !== undefined && (
                  <span className="shrink-0 font-mono text-[11px] tabular-nums">
                    <span className="text-green">+{row.add}</span>{" "}
                    <span className="text-red">−{row.del}</span>
                  </span>
                )}
                </>
              );
              const rowClass = "flex min-h-7 w-full items-center gap-2 rounded-[6px] px-1.5 py-0.5 text-left";
              const animation = { animation: `fade-up 320ms cubic-bezier(0.23,1,0.32,1) ${i * 120}ms both` };

              if (variant === "Search") {
                return (
                  <a
                    key={row.primary}
                    href={row.href}
                    target="_blank"
                    rel="noreferrer"
                    className={`${rowClass} transition-colors duration-150 hover:bg-hover`}
                    style={animation}
                  >
                    {content}
                  </a>
                );
              }

              if (variant === "Coding") {
                const selected = selectedTool === row.primary;
                return (
                  <button
                    key={row.primary}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setSelectedTool(selected ? null : row.primary)}
                    className={`${rowClass} transition-colors duration-150 ${selected ? "bg-inset" : "hover:bg-hover"}`}
                    style={animation}
                  >
                    {content}
                  </button>
                );
              }

              return (
                <div key={row.primary} className={rowClass} style={animation}>
                  {content}
                </div>
              );
            })}
            {variant === "Search" && stage >= 3 && (
              <span className="text-[12px] text-ink-3" style={{ animation: "fade-in 300ms ease-out both" }}>
                +7 more
              </span>
            )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
