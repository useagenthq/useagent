"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
// clsx-only (not cnExt): tailwind-merge misgroups the custom `text-mono-label`
// utility with the `text-neutral-*` color in the same call and drops it, blowing
// the tab labels up to the inherited 16px instead of the 11px mono-label rhythm.
import { cx as cn } from "@/utils/cx";
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
 *
 * Memoized: SessionView memoizes `allSteps`, so renders that don't change the
 * step list (drag commits, tab bookkeeping) skip this pane entirely.
 */
export const TerminalPane = memo(function TerminalPane({
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
  // Parse once PER STEP LIST, not per render: the row render, the in-flight
  // detection, and the autoscroll signature all read the same
  // command/output/exit projection.
  const parsedCommands = useMemo(
    () =>
      steps
        .filter((s) => s.kind === "command")
        .map((step) => ({ step, ...parseCommandStep(step) })),
    [steps],
  );
  // The last command is genuinely in-flight (just invoked, no output/exit yet)
  // only while the thread is live - an opencode tool emits its `$ command` line
  // at `running`, before its output lands. A settled command from a PRIOR turn
  // must NOT be mistaken for in-flight (the old `live && isLast` caret did this,
  // so a finished thread's last command blinked as if it were still running).
  const last = parsedCommands.at(-1);
  const lastInflight = live && !!last && last.output === null && last.exitCode === null;
  const bodyRef = useRef<HTMLDivElement>(null);
  // Stick-to-bottom autoscroll: follow commands + their output as they stream,
  // but ONLY while the user is already near the bottom - scrolling up to read
  // earlier output must never be yanked back down (same pattern as Conversation).
  const stickRef = useRef(true);
  // Shell = a live PTY into the conversation's sandbox (type alongside the
  // agent); Log = the run's command steps (read-only). Shell is the primary tab
  // whenever a live sandbox exists, so default to it when we have a run to
  // attach to and fall back to the read-only Log otherwise.
  const [tab, setTab] = useState<"log" | "shell">(runId ? "shell" : "log");

  // Re-pin on any content change: a new command, an in-place output/exit
  // enrichment (same step id, new payload), or the live working footer toggling.
  const logSignature =
    parsedCommands
      .map((p) => `${p.step.id}:${p.output?.length ?? 0}:${p.exitCode ?? ""}`)
      .join("|") + `|${live ? 1 : 0}`;
  useEffect(() => {
    const el = bodyRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [logSignature]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-neutral-950" data-testid="terminal-pane">
      <div className="flex shrink-0 items-center gap-2.5 border-b border-white/10 px-3.5 py-2">
        <span className="text-mono-label text-neutral-400">Terminal</span>
        <span className="text-mono-label rounded border border-white/10 px-1.5 py-px text-neutral-500">
          {engineLabel(engine)}
        </span>
        {runId && (
          <span className="ml-auto flex items-center gap-0.5">
            {(["shell", "log"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                data-testid={`terminal-tab-${t}`}
                className={cn(
                  "text-mono-label rounded px-1.5 py-0.5 transition-colors",
                  tab === t
                    ? "bg-white/10 text-neutral-200"
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
        data-testid="terminal-log"
        onScroll={(e) => {
          const el = e.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3 [font-family:var(--font-mono)] text-[13px] leading-6"
      >
        {parsedCommands.length === 0 ? (
          <p className="text-neutral-600" data-testid="terminal-log-empty">
            {live ? "Booting session…" : "No commands were run."}
          </p>
        ) : (
          <>
            {parsedCommands.map(({ step, command, output, exitCode }, i) => {
              const isLast = i === parsedCommands.length - 1;
              const failed = typeof exitCode === "number" && exitCode !== 0;
              return (
                <div key={step.id} className="animate-ai-fade-up">
                  <div className="flex gap-2">
                    <span className="shrink-0 select-none text-green-400">$</span>
                    <span className="min-w-0 break-words text-neutral-100">
                      {command}
                      {isLast && lastInflight && (
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
                  {failed && <div className="pl-4 text-red-400">exit {exitCode}</div>}
                </div>
              );
            })}
            {/* Live activity: while the run is live but the last command has
                already settled (or the current turn has not emitted its command
                yet - ACP tools surface a step only on completion), no command
                line can move on its own. This footer keeps the log visibly
                moving so an in-flight run never reads as a frozen, stale pane. */}
            {live && !lastInflight && (
              <div className="mt-0.5 flex items-center gap-2" data-testid="terminal-log-working">
                <span className="shrink-0 select-none text-green-400">$</span>
                <span className="agent-progress-loading-text text-neutral-500">working</span>
                <span
                  className="ai-caret inline-block h-4 w-2 translate-y-0.5 bg-neutral-500"
                  aria-hidden
                />
              </div>
            )}
          </>
        )}
      </div>
      )}
    </div>
  );
});
