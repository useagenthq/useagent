"use client";

import { useEffect, useRef, useState } from "react";
// clsx-only (not cnExt): tailwind-merge misgroups the custom `text-mono-label`
// utility with the `text-neutral-*` color in the same call and drops it, blowing
// the tab labels up to the inherited 16px instead of the 11px mono-label rhythm.
import { cn } from "@/utils/cn";
import { InteractiveTerminal } from "@/components/chat/interactive-terminal";
import {
  engineLabel,
  parseCommandStep,
  type ApiStep,
  type EngineId,
} from "@/components/chat/types";

/**
 * The bottom pane of the session's editor|terminal split: a cursor-style dark
 * terminal that streams the run's command steps as `$ command` lines with any
 * captured output beneath. Intentionally uses the fixed `neutral-950` scale
 * (not the theme-flipping `bg-strong-950` token) so the terminal stays dark in
 * both light and dark app themes, like a real IDE terminal.
 */
export function TerminalPane({
  steps,
  live,
  engine,
  runId,
}: {
  steps: ApiStep[];
  live: boolean;
  engine: EngineId;
  /** Any run in the conversation — the shell attaches to the THREAD's sandbox. */
  runId?: string;
}) {
  const commandSteps = steps.filter((s) => s.kind === "command");
  const bodyRef = useRef<HTMLDivElement>(null);
  // Shell = a live PTY into the conversation's sandbox (type alongside the
  // agent); Log = the run's command steps (read-only). Shell is the primary tab
  // whenever a live sandbox exists, so default to it when we have a run to
  // attach to and fall back to the read-only Log otherwise.
  const [tab, setTab] = useState<"log" | "shell">(runId ? "shell" : "log");

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [commandSteps.length, live]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-neutral-950">
      <div className="flex shrink-0 items-center gap-2.5 border-b border-white-alpha-10 px-3.5 py-2">
        <span className="text-mono-label text-neutral-400">Terminal</span>
        <span className="text-mono-label rounded border border-white-alpha-10 px-1.5 py-px text-neutral-500">
          {engineLabel(engine)}
        </span>
        {runId && (
          <span className="ml-auto flex items-center gap-0.5">
            {(["shell", "log"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={cn(
                  "text-mono-label rounded px-1.5 py-0.5 transition-colors",
                  tab === t
                    ? "bg-white-alpha-10 text-neutral-200"
                    : "text-neutral-600 hover:text-neutral-400",
                )}
              >
                {t === "shell" ? "Shell" : "Log"}
              </button>
            ))}
          </span>
        )}
      </div>

      {tab === "shell" && runId ? (
        <InteractiveTerminal runId={runId} />
      ) : (
      <div
        ref={bodyRef}
        className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3 [font-family:var(--font-mono)] text-[13px] leading-6"
      >
        {commandSteps.length === 0 ? (
          <p className="text-neutral-600">
            {live ? "Booting session…" : "No commands were run."}
          </p>
        ) : (
          commandSteps.map((step, i) => {
            const { command, output, exitCode } = parseCommandStep(step);
            const isLast = i === commandSteps.length - 1;
            const failed = typeof exitCode === "number" && exitCode !== 0;
            return (
              <div key={step.id} className="animate-ai-fade-up">
                <div className="flex gap-2">
                  <span className="shrink-0 select-none text-green-400">$</span>
                  <span className="min-w-0 break-words text-neutral-100">
                    {command}
                    {live && isLast && (
                      <span
                        className="ai-caret ml-0.5 inline-block h-4 w-2 translate-y-0.5 bg-neutral-100"
                        aria-hidden
                      />
                    )}
                  </span>
                </div>
                {output && (
                  <div className="whitespace-pre-wrap break-words pl-4 text-neutral-500">
                    {output}
                  </div>
                )}
                {failed && (
                  <div className="pl-4 text-red-400">exit {exitCode}</div>
                )}
              </div>
            );
          })
        )}
      </div>
      )}
    </div>
  );
}
