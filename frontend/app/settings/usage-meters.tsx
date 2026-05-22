"use client";

import { useCallback, useEffect, useState } from "react";
import { backendFetch } from "@/lib/backend-fetch";
import { BackendUnreachable } from "@/components/shared/backend-unreachable";
import { modelStyle } from "@/components/shared/model-mark";
import { cnExt } from "@/utils/cn";
import { compactNumber } from "@/utils/format";
import { extractFleet, type FleetData, type ModelBurn } from "@/components/fleet/fleet-data";

// Real per-model consumption for the Settings > Usage card, from GET /api/fleet
// (the same live source as the workspace Limits card). Every figure is real:
// the meter is a model's share of today's token burn. Honest states - loading,
// a distinct "no usage yet", and backend-unreachable (never an outage dressed up
// as empty).

const METER_BARS = 16;

/** Segmented share meter - how much of today's token burn this model is. */
function ShareMeter({ value, fill }: { value: number; fill: string }) {
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

function ModelRow({ model, totalTokens }: { model: ModelBurn; totalTokens: number }) {
  const { Mark, markClass, fill } = modelStyle(model.model);
  const share = totalTokens > 0 ? model.tokens / totalTokens : 0;
  return (
    <div className="flex items-center gap-2 py-1.5">
      <Mark className={cnExt("size-[18px] shrink-0", markClass)} aria-hidden />
      <span className="min-w-0 flex-1 truncate text-label-sm text-text-strong-950">
        {model.model}
      </span>
      <span className="font-mono text-label-xs tabular-nums text-text-soft-400">
        {model.tokens > 0 ? compactNumber(model.tokens) : "-"}
      </span>
      <span className="w-9 text-right text-label-xs tabular-nums text-text-sub-600">
        {Math.round(share * 100)}%
      </span>
      <ShareMeter value={share} fill={fill} />
    </div>
  );
}

type State = "loading" | "error" | { fleet: FleetData };

export function UsageMeters() {
  const [state, setState] = useState<State>("loading");

  const load = useCallback(async () => {
    setState("loading");
    try {
      const res = await backendFetch("/api/fleet", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const fleet = extractFleet(await res.json());
      if (!fleet) throw new Error("bad shape");
      setState({ fleet });
    } catch {
      setState("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (state === "loading") {
    return (
      <div className="rounded-xl border border-stroke-soft-200 bg-bg-weak-50 px-4 py-6 text-center">
        <p className="text-paragraph-xs text-text-soft-400">Loading usage...</p>
      </div>
    );
  }

  if (state === "error") {
    return <BackendUnreachable onRetry={() => void load()} />;
  }

  const { fleet } = state;
  // Order by real token share (highest first); models that never emitted usage
  // sink to the bottom with an honest zero meter.
  const models = [...fleet.models].sort((a, b) => b.tokens - a.tokens);

  if (models.length === 0) {
    return (
      <div className="rounded-xl border border-stroke-soft-200 bg-bg-weak-50 px-4 py-6 text-center">
        <p className="text-label-sm text-text-strong-950">No model usage yet</p>
        <p className="mt-0.5 text-paragraph-xs text-text-sub-600">
          Model consumption appears here once you run a task this cycle.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-stroke-soft-200 bg-bg-weak-50 px-4 py-3">
      {models.map((model) => (
        <ModelRow key={model.model} model={model} totalTokens={fleet.totalTokens} />
      ))}
      <div className="mt-2 flex items-center justify-between border-t border-stroke-soft-200 pt-2.5">
        <span className="text-mono-label text-text-soft-400">tokens today</span>
        <span className="font-mono text-label-sm tabular-nums text-text-strong-950">
          {compactNumber(fleet.totalTokens)}
          {fleet.totalCost > 0 ? (
            <span className="ml-2 text-text-soft-400">${fleet.totalCost.toFixed(2)}</span>
          ) : null}
        </span>
      </div>
    </div>
  );
}
