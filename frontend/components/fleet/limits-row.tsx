import { NumberTicker } from "@/components/shared/number-ticker";
import { modelStyle } from "@/components/shared/model-mark";
import { cnExt } from "@/utils/cn";
import { compactNumber, formatDuration } from "@/utils/format";
import type { FleetData, MachineStats, ModelBurn } from "./fleet-data";
import { Panel, PanelHeading } from "./panel";

const METER_BARS = 16;

/** Segmented share meter — how much of today's total token burn this model is. */
function SegMeter({ value, fill }: { value: number; fill: string }) {
  const filled = Math.round(METER_BARS * Math.min(1, Math.max(0, value)));
  return (
    <span className="flex items-center gap-[3px]" aria-hidden>
      {Array.from({ length: METER_BARS }, (_, index) => (
        <span
          key={index}
          className={cnExt("h-3 w-[3px] rounded-full", index < filled ? fill : "bg-bg-soft-200")}
        />
      ))}
    </span>
  );
}

/** One model's real burn: runs / completion / avg duration / cost + a token
 *  count and a share-of-total meter. */
function ModelRow({ model, totalTokens }: { model: ModelBurn; totalTokens: number }) {
  const { Mark, markClass, fill } = modelStyle(model.model);
  const share = totalTokens > 0 ? model.tokens / totalTokens : 0;
  const meta = [
    `${model.runs} run${model.runs === 1 ? "" : "s"}`,
    `${model.completed}/${model.runs} done`,
    model.avgMs != null ? `${formatDuration(model.avgMs)} avg` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="flex items-start gap-2.5 py-2">
      <Mark className={cnExt("mt-0.5 size-[18px] shrink-0", markClass)} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="truncate text-label-sm text-text-strong-950">{model.model}</p>
        <p className="mt-0.5 truncate text-mono-label text-text-soft-400">{meta}</p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <span className="font-mono text-label-sm tabular-nums text-text-strong-950">
          {model.tokens > 0 ? compactNumber(model.tokens) : "-"}
        </span>
        {model.cost > 0 && (
          <span className="font-mono text-label-xs tabular-nums text-text-soft-400">
            ${model.cost.toFixed(2)}
          </span>
        )}
        <SegMeter value={share} fill={fill} />
      </div>
    </div>
  );
}

/** A labelled figure in the Machine card. */
function StatRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-mono-label text-text-sub-600">{label}</span>
      <span className="font-mono text-label-sm tabular-nums text-text-strong-950">{value}</span>
    </div>
  );
}

/** Models · burn — real per-model token/cost aggregates for today. */
function ModelsPanel({ fleet }: { fleet: FleetData | null }) {
  return (
    <Panel>
      <PanelHeading>Models · burn</PanelHeading>
      {fleet == null ? (
        <p className="py-2 text-paragraph-xs text-text-soft-400">Loading usage…</p>
      ) : fleet.models.length === 0 ? (
        <p className="py-2 text-paragraph-xs text-text-soft-400">No model runs yet today.</p>
      ) : (
        <div className="divide-y divide-stroke-soft-200">
          {fleet.models.map((model) => (
            <ModelRow key={model.model} model={model} totalTokens={fleet.totalTokens} />
          ))}
        </div>
      )}

      <div className="mt-4 flex items-end justify-between border-t border-stroke-soft-200 pt-4">
        <div>
          <p className="font-mono text-label-lg font-semibold tabular-nums text-text-strong-950">
            <NumberTicker value={fleet?.totalTokens ?? 0} format={compactNumber} />
          </p>
          <p className="mt-1 text-mono-label text-text-soft-400">tokens today</p>
        </div>
        <div className="text-right">
          <p className="font-mono text-title-h6 tabular-nums text-text-strong-950">
            ${(fleet?.totalCost ?? 0).toFixed(2)}
          </p>
          <p className="mt-1 text-mono-label text-text-soft-400">cost today</p>
        </div>
      </div>
    </Panel>
  );
}

/** Machine — the org's live Daytona footprint + the real snapshot in use. */
function MachinePanel({ machine }: { machine: MachineStats | null }) {
  const sandboxes = machine?.sandboxes ?? null;
  return (
    <Panel>
      <PanelHeading
        right={
          <span className="inline-flex items-center rounded-md bg-bg-weak-50 px-2 py-0.5 font-mono text-[0.6875rem] text-text-sub-600">
            {machine?.snapshot ?? "-"}
          </span>
        }
      >
        Machine
      </PanelHeading>

      {sandboxes == null ? (
        <p className="py-2 text-paragraph-xs text-text-soft-400">Live sandbox count updating…</p>
      ) : (
        <>
          <div className="mb-4">
            <p className="font-mono text-label-lg font-semibold tabular-nums text-text-strong-950">
              <NumberTicker value={sandboxes.active} />
            </p>
            <p className="mt-1 text-mono-label text-text-soft-400">active sandboxes</p>
          </div>
          <div className="space-y-2.5 border-t border-stroke-soft-200 pt-4">
            <StatRow label="Live threads" value={sandboxes.liveThreads} />
            <StatRow label="Idle · retained" value={sandboxes.idle} />
          </div>
        </>
      )}
    </Panel>
  );
}

/**
 * The "Limits" row: real per-model token/cost burn for today (from the runs +
 * opencode usage log) and the org's real Daytona sandbox footprint. Every figure
 * is derived from live data via GET /api/fleet — nothing is fabricated.
 */
export function LimitsRow({ fleet }: { fleet: FleetData | null }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <ModelsPanel fleet={fleet} />
      <MachinePanel machine={fleet?.machine ?? null} />
    </div>
  );
}
