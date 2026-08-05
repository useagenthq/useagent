"use client";

import { useEffect, useState } from "react";
import { RiCheckLine, RiRobot2Line } from "@remixicon/react";
import { cnExt as cn } from "@/utils/cn";
import {
  deriveSubagents,
  formatDuration,
  type ApiStep,
  type SubagentCard,
} from "@/components/chat/types";

/**
 * The right-rail "Agents" tab: one card per fanned-out subagent, mirroring
 * the reference tool's session view. Each card shows the subagent's description, a live status
 * line (its latest activity), an elapsed timer, and a run-state indicator.
 *
 * Everything is derived from the same ordered step stream that feeds the
 * conversation (`useRunStream`) — no extra fetch — via `deriveSubagents`, which
 * attributes each nested step to the card whose native child session it ran in
 * (exact even with concurrent subagents), falling back to the legacy spawn-order
 * heuristic only for pre-native-stamp runs. See `types.ts`.
 */

/** Ticks once a second while `live`, so elapsed timers advance; frozen otherwise. */
function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);
  return now;
}

function AgentCardRow({ card, live }: { card: SubagentCard; live: boolean }) {
  const now = useNow(live);
  const endedAt = live ? now : (card.lastActivityAt ?? card.startedAt);
  const elapsed = Number.isFinite(card.startedAt)
    ? Math.max(0, endedAt - card.startedAt)
    : 0;
  const status = card.status ?? (live ? "Starting…" : "No activity recorded");

  return (
    <div className="bg-bg-weak-50 border-stroke-soft-200 animate-ai-fade-up flex items-start gap-2.5 rounded-xl border p-3">
      <span className="bg-feature-lighter text-feature-base mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-lg">
        <RiRobot2Line className="size-3.5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-label-sm text-text-strong-950 min-w-0 flex-1 truncate">
            {card.title}
          </span>
          {live ? (
            <span
              className="ai-loading-pixel bg-blue-500 size-1.5 shrink-0 rounded-full"
              aria-label="running"
            />
          ) : (
            <RiCheckLine className="text-success-base size-4 shrink-0" aria-label="completed" />
          )}
        </div>
        <div className="mt-1 flex items-center gap-2">
          <span
            className={cn(
              "text-paragraph-xs text-text-sub-600 min-w-0 flex-1 truncate",
              live && card.status && "agent-progress-loading-text",
            )}
          >
            {status}
          </span>
          <span className="text-text-soft-400 shrink-0 font-mono text-label-xs tabular-nums">
            {formatDuration(elapsed)}
          </span>
        </div>
      </div>
    </div>
  );
}

export function AgentsRail({ steps, live }: { steps: ApiStep[]; live: boolean }) {
  const cards = deriveSubagents(steps).cards;
  // Cards pulse while the run is live and hasn't emitted its terminal `done`
  // step; once it settles every card flips to the completed check.
  const running = live && !steps.some((s) => s.kind === "done");

  if (cards.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <p className="text-paragraph-sm text-text-soft-400 text-center">
          No subagents in this conversation yet.
        </p>
      </div>
    );
  }

  return (
    <div className="h-full space-y-2.5 overflow-y-auto p-3">
      {cards.map((card) => (
        <AgentCardRow key={card.id} card={card} live={running} />
      ))}
    </div>
  );
}
