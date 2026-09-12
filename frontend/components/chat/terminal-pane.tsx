"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
// clsx-only (not cnExt): tailwind-merge misgroups the custom `text-mono-label`
// utility with the `text-static-white/*` color in the same call and drops it, blowing
// the tab labels up to the inherited 16px instead of the 11px mono-label rhythm.
import { cx as cn } from "@/utils/cx";
import { InteractiveTerminal } from "@/components/chat/interactive-terminal";
import { compressTerminalLog } from "@/components/chat/terminal-log-model";
import { type ApiStep, type EngineId, engineLabel } from "@/components/chat/types";

/**
 * The bottom pane of the session's editor|terminal split: a cursor-style dark
 * terminal whose Log tab is the run's compressed transcript (see
 * ./terminal-log-model): `$ command` lines with the readable text of their
 * result beneath, and every other call as one line. Intentionally uses the fixed
 * `neutral-950` scale (not the theme-flipping `bg-strong-950` token) so the
 * terminal stays dark in both light and dark app themes, like a real IDE
 * terminal. Text on it uses `static-white` alphas for the same reason: the
 * semantic text tokens and the neutral primitives invert per theme, which left
 * the labels at 1.4 to 2.3:1 on the dark surface.
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
  // Compress once PER STEP LIST, not per render: the row render, the in-flight
  // detection, and the autoscroll signature all read the same transcript.
  const entries = useMemo(() => compressTerminalLog(steps), [steps]);
  // The last command is genuinely in-flight (just invoked, no output/exit yet)
  // only while the thread is live - an opencode tool emits its `$ command` line
  // at `running`, before its output lands. A settled command from a PRIOR turn
  // must NOT be mistaken for in-flight (the old `live && isLast` caret did this,
  // so a finished thread's last command blinked as if it were still running).
  const last = entries.at(-1);
  const lastInflight = live && last?.kind === "command" && !last.settled;
  const bodyRef = useRef<HTMLDivElement>(null);
  // Stick-to-bottom autoscroll: follow commands + their output as they stream,
  // but ONLY while the user is already near the bottom - scrolling up to read
  // earlier output must never be yanked back down (same pattern as Conversation).
  const stickRef = useRef(true);
  // Shell = a live PTY into the conversation's sandbox (type alongside the
  // agent); Log = the run's transcript (read-only). Shell is the primary tab
  // whenever a live sandbox exists, so default to it when we have a run to
  // attach to and fall back to the read-only Log otherwise.
  const [tab, setTab] = useState<"log" | "shell">(runId ? "shell" : "log");

  // Re-pin on any content change: a new entry, an in-place output/exit
  // enrichment (same step id, new payload), or the live working footer toggling.
  const logSignature = `${entries
    .map((entry) =>
      entry.kind === "command"
        ? `${entry.key}:${entry.lines.length}:${entry.hiddenLines}:${entry.exitCode ?? ""}`
        : `${entry.key}:${entry.detail?.length ?? 0}`,
    )
    .join("|")}|${live ? 1 : 0}`;
  useEffect(() => {
    const el = bodyRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [logSignature]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-neutral-950" data-testid="terminal-pane">
      <div className="flex shrink-0 items-center gap-2.5 border-b border-white/10 px-3.5 py-2">
        <span className="text-mono-label text-static-white/60">Terminal</span>
        <span className="text-mono-label rounded border border-white/10 px-1.5 py-px text-static-white/50">
          {engineLabel(engine)}
        </span>
        {runId && (
          <span className="ml-auto flex items-center gap-0.5">
            {(["shell", "log"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                aria-pressed={tab === t}
                data-testid={`terminal-tab-${t}`}
                className={cn(
                  "text-mono-label rounded-md px-2 py-1 transition-colors",
                  tab === t
                    ? "bg-neutral-800 text-white ring-1 ring-inset ring-white/15 shadow-sm"
                    : "text-static-white/50 hover:bg-white/5 hover:text-static-white/80",
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
        {entries.length === 0 ? (
          <p className="text-static-white/50" data-testid="terminal-log-empty">
            {live ? "Booting session…" : "No commands were run."}
          </p>
        ) : (
          <>
            {entries.map((entry, i) =>
              entry.kind === "command" ? (
                <div key={entry.key} className="animate-ai-fade-up" data-testid="terminal-log-command">
                  <div className="flex gap-2">
                    <span className="shrink-0 select-none text-green-400">$</span>
                    <span className="min-w-0 break-words text-neutral-100">
                      {entry.command}
                      {i === entries.length - 1 && lastInflight && (
                        <span
                          className="ai-caret ml-0.5 inline-block h-4 w-2 translate-y-0.5 bg-neutral-100"
                          aria-hidden
                        />
                      )}
                    </span>
                  </div>
                  {entry.lines.length > 0 && (
                    <div className="whitespace-pre-wrap break-words pl-4 text-static-white/70">
                      {entry.lines.join("\n")}
                    </div>
                  )}
                  {entry.hiddenLines > 0 && (
                    <div className="pl-4 text-static-white/40" data-testid="terminal-log-more">
                      +{entry.hiddenLines} lines
                    </div>
                  )}
                  {entry.failed && (
                    <div className="pl-4 text-red-400">
                      {entry.exitCode === null ? "failed" : `exit ${entry.exitCode}`}
                    </div>
                  )}
                </div>
              ) : (
                <div key={entry.key} className="animate-ai-fade-up flex min-w-0 gap-2" data-testid="terminal-log-call">
                  <span className="shrink-0 select-none text-static-white/40">·</span>
                  <span className={cn("shrink-0", entry.failed ? "text-red-400" : "text-static-white/70")}>
                    {entry.label}
                  </span>
                  {entry.detail && (
                    <span className="min-w-0 truncate text-static-white/40">{entry.detail}</span>
                  )}
                </div>
              ),
            )}
            {/* Live activity: while the run is live but the last command has
                already settled (or the current turn has not emitted its command
                yet - ACP tools surface a step only on completion), no command
                line can move on its own. This footer keeps the log visibly
                moving so an in-flight run never reads as a frozen, stale pane. */}
            {live && !lastInflight && (
              <div className="mt-0.5 flex items-center gap-2" data-testid="terminal-log-working">
                <span className="shrink-0 select-none text-green-400">$</span>
                <span className="agent-progress-loading-text text-static-white/60">working</span>
                <span
                  className="ai-caret inline-block h-4 w-2 translate-y-0.5 bg-static-white/60"
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
