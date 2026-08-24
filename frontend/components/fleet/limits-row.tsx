"use client";

import { useState } from "react";
import { RiArrowDownSLine } from "@remixicon/react";
import { AnimatePresence, motion } from "motion/react";
import { NumberTicker } from "@/components/shared/number-ticker";
import { modelStyle } from "@/components/shared/model-mark";
import { cx } from "@/utils/cx";
import { compactNumber, formatDuration } from "@/utils/format";
import type { CapacityData, FleetData, MachineStats, ModelBurn } from "./fleet-data";
import { Panel } from "./panel";

/**
 * The "Limits" card, on the agent-limits block recipe (stacked meter bar +
 * expandable breakdown, separator, labelled stat section) but bound to OUR
 * real GET /api/fleet data: per-model token/cost burn for today and the org's
 * live Daytona footprint. We track no token budget, reset timers, or sandbox
 * caps, so the block's "used / max", reset copy, and capped progress bars are
 * omitted rather than faked; every percentage is a share of today's real burn.
 */

const EASE = [0.22, 1, 0.36, 1] as const;

/** Thin rounded meter track; children are the fill segments (block recipe). */
function Bar({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cx("flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-chart-track", className)}>
      {children}
    </div>
  );
}

/** Breakdown legend row: swatch · model + real meta · tokens · share. */
function ModelRow({ model, totalTokens }: { model: ModelBurn; totalTokens: number }) {
  const { fill } = modelStyle(model.model);
  const pct = totalTokens > 0 ? (model.tokens / totalTokens) * 100 : 0;
  const meta = [
    `${model.runs} run${model.runs === 1 ? "" : "s"}`,
    `${model.completed}/${model.runs} done`,
    model.avgMs ? `${formatDuration(model.avgMs)} avg` : null,
    model.cost > 0 ? `$${model.cost.toFixed(2)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="flex items-start gap-2 py-[5px]">
      <span className={cx("mt-[5px] size-2.5 shrink-0 rounded-[3px]", fill)} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="truncate text-body-regular text-text-primary">{model.model}</p>
        <p className="mt-0.5 truncate text-body-2-regular text-text-tertiary">{meta}</p>
      </div>
      <span className="text-body-regular text-text-tertiary tabular-nums">
        {model.tokens > 0 ? compactNumber(model.tokens) : "-"}
      </span>
      <span className="w-14 text-right text-body-medium text-text-primary tabular-nums">
        {model.tokens > 0 ? `${pct.toFixed(1)}%` : "-"}
      </span>
    </div>
  );
}

/** Token burn · today: stacked per-model meter + expandable breakdown. */
function BurnSection({ fleet }: { fleet: FleetData | null }) {
  const [expanded, setExpanded] = useState(false);

  if (fleet == null || fleet.models.length === 0) {
    return (
      <div className="flex flex-col py-1">
        <span className="text-body-medium text-text-secondary">Token burn · today</span>
        <p className="mt-2 text-body-2-regular text-text-tertiary">
          {fleet == null ? "Loading usage…" : "No model runs yet today."}
        </p>
      </div>
    );
  }

  const total = fleet.totalTokens;
  const share = (n: number) => (n / Math.max(1, total)) * 100;

  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="group -mx-2 flex cursor-pointer items-center justify-between gap-3 rounded-2lg px-2 py-1 text-left outline-none transition-colors duration-150 hover:bg-background-secondary-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring"
      >
        <span className="text-body-medium text-text-secondary">Token burn · today</span>
        <span className="flex items-center gap-2">
          <span className="text-body-medium whitespace-nowrap text-text-secondary tabular-nums">
            <NumberTicker value={total} format={compactNumber} /> tokens
            <span className="text-text-primary"> · ${fleet.totalCost.toFixed(2)}</span>
          </span>
          <RiArrowDownSLine
            className={cx(
              "size-4 shrink-0 text-text-tertiary transition-transform duration-200 ease-out group-hover:text-text-secondary",
              expanded && "rotate-180",
            )}
            aria-hidden
          />
        </span>
      </button>

      <Bar className="mt-1.5">
        {fleet.models.map((m) =>
          m.tokens > 0 ? (
            <div
              key={m.model}
              className={cx("h-full shrink-0 transition-[width] duration-500 ease-out", modelStyle(m.model).fill)}
              style={{ width: `${share(m.tokens)}%` }}
              title={`${m.model} · ${compactNumber(m.tokens)}`}
            />
          ) : null,
        )}
      </Bar>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="breakdown"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.32, ease: EASE }}
            className="-mx-2 overflow-hidden px-2"
          >
            <div className="flex flex-col pt-3">
              {fleet.models.map((m) => (
                <ModelRow key={m.model} model={m} totalTokens={total} />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function MachineRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-[5px]">
      <span className="text-body-regular text-text-primary">{label}</span>
      <span className="text-body-medium text-text-primary tabular-nums">{children}</span>
    </div>
  );
}

/** Machine · snapshot: the org's live Daytona footprint (no caps, so no bars). */
function MachineSection({ machine }: { machine: MachineStats | null }) {
  const sandboxes = machine?.sandboxes ?? null;
  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between gap-3 py-1">
        <span className="min-w-0 truncate text-body-medium text-text-secondary">
          Machine{machine ? ` · ${machine.snapshot}` : ""}
        </span>
      </div>
      {sandboxes == null ? (
        <p className="mt-1 text-body-2-regular text-text-tertiary">Live sandbox count updating…</p>
      ) : (
        <div className="flex flex-col pt-1">
          <MachineRow label="Active sandboxes">
            <NumberTicker value={sandboxes.active} />
          </MachineRow>
          <MachineRow label="Live threads">{sandboxes.liveThreads}</MachineRow>
          <MachineRow label="Idle · retained">{sandboxes.idle}</MachineRow>
        </div>
      )}
    </div>
  );
}

/** Capacity · fleet: org active sandboxes vs limit, durable queued backlog, and
 *  host saturation (HA Stage A, from GET /api/fleet/capacity). Omitted when the
 *  snapshot has not loaded yet. */
function CapacitySection({ capacity }: { capacity: CapacityData | null }) {
  if (capacity == null) return null;
  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between gap-3 py-1">
        <span className="text-body-medium text-text-secondary">Capacity · fleet</span>
        {capacity.globalSaturated ? (
          <span className="text-body-2-medium text-text-tertiary">host at capacity</span>
        ) : null}
      </div>
      <div className="flex flex-col pt-1">
        <MachineRow label="Org sandboxes · in use">
          {capacity.orgActive} / {capacity.orgLimit}
        </MachineRow>
        <MachineRow label="Queued · waiting">
          {capacity.queued}
          <span className="text-text-tertiary"> / {capacity.queueLimit}</span>
        </MachineRow>
        <MachineRow label="Host sandboxes · in use">
          {capacity.globalActive} / {capacity.globalLimit}
        </MachineRow>
      </div>
    </div>
  );
}

/**
 * The "Limits" row: real per-model token/cost burn for today (from the runs +
 * opencode usage log), the org's real Daytona sandbox footprint, and fleet
 * capacity + durable queue. Every figure is derived from live data via
 * GET /api/fleet(/capacity) — nothing is fabricated.
 */
export function LimitsRow({
  fleet,
  capacity,
}: {
  fleet: FleetData | null;
  capacity?: CapacityData | null;
}) {
  return (
    <Panel>
      <BurnSection fleet={fleet} />
      <div className="my-4 h-px w-full bg-separator-border-strong" />
      <MachineSection machine={fleet?.machine ?? null} />
      {capacity ? (
        <>
          <div className="my-4 h-px w-full bg-separator-border-strong" />
          <CapacitySection capacity={capacity} />
        </>
      ) : null}
    </Panel>
  );
}
