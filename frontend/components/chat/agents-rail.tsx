"use client";

import { useEffect, useState } from "react";
import {
  RiArrowLeftLine,
  RiArrowRightSLine,
  RiCheckLine,
  RiRobot2Line,
} from "@remixicon/react";
import { cnExt as cn } from "@/utils/cn";
import { ToolStepRow } from "@/components/chat/tool-step-row";
import { deriveTrace, formatDuration, type ApiStep } from "@/components/chat/types";
import { deriveSubagents, type SubagentCard } from "@/components/chat/subagents";

/**
 * The right-rail "Agents" tab: one card per fanned-out subagent, mirroring
 * the reference tool's session view. Each card shows the subagent's description, a live status
 * line (its latest activity), an elapsed timer, and a run-state indicator.
 *
 * Everything is derived from the same ordered step stream that feeds the
 * conversation (`useRunStream`) — no extra fetch — via `deriveSubagents`, which
 * attributes each nested step to the card whose native child session it ran in
 * (exact even with concurrent subagents), falling back to the legacy spawn-order
 * heuristic only for pre-native-stamp runs. See `subagents.ts`.
 *
 * Cards are openable: selecting one swaps this rail to a detail view of THAT
 * subagent — its objective, status, and only its own native-attributed activity
 * (via `ownerByStep`) — mirroring the subagent viewing-pane grammar. Back returns
 * to the list. A native child session is a slice of the parent run's step stream
 * (not a separate Skynet run), so this is in-rail master/detail rather than the
 * separate-run slide-over in `subagent-pane.tsx`.
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

/** Elapsed ms this card has been (or was) active; frozen once the run settles. */
function elapsedOf(card: SubagentCard, now: number, live: boolean): number {
  const endedAt = live ? now : (card.lastActivityAt ?? card.startedAt);
  return Number.isFinite(card.startedAt) ? Math.max(0, endedAt - card.startedAt) : 0;
}

/** Live pulse dot / settled check — shared by the card and the detail header. */
function RunStateDot({ live }: { live: boolean }) {
  return live ? (
    <span
      className="ai-loading-pixel bg-blue-500 size-1.5 shrink-0 rounded-full"
      aria-label="running"
    />
  ) : (
    <RiCheckLine className="text-success-base size-4 shrink-0" aria-label="completed" />
  );
}

function AgentCardRow({
  card,
  live,
  onOpen,
}: {
  card: SubagentCard;
  live: boolean;
  onOpen: () => void;
}) {
  const now = useNow(live);
  const elapsed = elapsedOf(card, now, live);
  const status = card.status ?? (live ? "Starting…" : "No activity recorded");

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Open subagent: ${card.title}`}
      className="bg-bg-weak-50 border-stroke-soft-200 hover:bg-bg-soft-200 animate-ai-fade-up flex w-full items-start gap-2.5 rounded-xl border p-3 text-left transition-colors"
    >
      <span className="bg-feature-lighter text-feature-base mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-lg">
        <RiRobot2Line className="size-3.5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-label-sm text-text-strong-950 min-w-0 flex-1 truncate">
            {card.title}
          </span>
          <RunStateDot live={live} />
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
      <RiArrowRightSLine className="text-text-soft-400 size-4 shrink-0 self-center" aria-hidden />
    </button>
  );
}

/**
 * The detail view for one subagent card. Its objective comes from the spawn
 * step's prompt (`deriveTrace(...).detail`); its activity is exactly the steps
 * native-attributed to this card (`ownerByStep`), never display order. Updates
 * live as steps stream in and freezes once the run settles.
 */
function AgentDetail({
  card,
  steps,
  ownerByStep,
  live,
  onBack,
}: {
  card: SubagentCard;
  steps: ApiStep[];
  ownerByStep: ReadonlyMap<string, string>;
  live: boolean;
  onBack: () => void;
}) {
  const now = useNow(live);
  const elapsed = elapsedOf(card, now, live);

  const spawn = steps.find((s) => s.id === card.id);
  const objective = spawn ? deriveTrace(spawn).detail : null;
  const activity = steps.filter((s) => ownerByStep.get(s.id) === card.id);

  return (
    <div className="flex h-full flex-col">
      <header className="border-stroke-soft-200 flex shrink-0 items-start gap-2 border-b px-3 py-2.5">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to agents list"
          className="text-text-sub-600 hover:bg-bg-soft-200 mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg transition-colors"
        >
          <RiArrowLeftLine className="size-4" aria-hidden />
        </button>
        <span className="bg-feature-lighter text-feature-base mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-lg">
          <RiRobot2Line className="size-3.5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-label-sm text-text-strong-950 min-w-0 flex-1 truncate">
              {card.title}
            </span>
            <RunStateDot live={live} />
          </div>
          <div className="mt-0.5 flex items-center gap-2">
            <span className="text-mono-label text-text-soft-400 flex-1">Subagent</span>
            <span className="text-text-soft-400 shrink-0 font-mono text-label-xs tabular-nums">
              {formatDuration(elapsed)}
            </span>
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {objective && objective !== card.title && (
          <p className="text-paragraph-sm text-text-sub-600 border-stroke-soft-200 border-b pb-3">
            {objective}
          </p>
        )}

        {activity.length === 0 ? (
          <p className="text-paragraph-sm text-text-soft-400 py-6 text-center">
            {live ? "Waiting for the first step…" : "No activity recorded."}
          </p>
        ) : (
          <div className="space-y-2.5">
            {activity.map((step, i) => (
              <ToolStepRow
                key={step.id}
                step={step}
                state={live && i === activity.length - 1 ? "running" : "done"}
                nested={false}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function AgentsRail({ steps, live }: { steps: ApiStep[]; live: boolean }) {
  const { cards, ownerByStep } = deriveSubagents(steps);
  const [selectedId, setSelectedId] = useState<string | null>(null);
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

  // Selection survives live re-derivation because card ids are stable; a missing
  // id (never happens — steps only append) falls back to the list.
  const selected = selectedId ? cards.find((c) => c.id === selectedId) : null;
  if (selected) {
    return (
      <AgentDetail
        card={selected}
        steps={steps}
        ownerByStep={ownerByStep}
        live={running}
        onBack={() => setSelectedId(null)}
      />
    );
  }

  return (
    <div className="h-full space-y-2.5 overflow-y-auto p-3">
      {cards.map((card) => (
        <AgentCardRow
          key={card.id}
          card={card}
          live={running}
          onOpen={() => setSelectedId(card.id)}
        />
      ))}
    </div>
  );
}
