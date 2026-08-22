"use client";

import { useCallback, useEffect, useState } from "react";
import { backendFetch } from "@/lib/backend-fetch";
import { BackendUnreachable } from "@/components/shared/backend-unreachable";
import { modelStyle } from "@/components/shared/model-mark";
import { cx } from "@/utils/cx";
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
          className={cx(
            "h-3 w-[3px] rounded-full",
            index < filled ? fill : "bg-background-tertiary-default",
          )}
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
      <Mark className={cx("size-[18px] shrink-0", markClass)} aria-hidden />
      <span className="min-w-0 flex-1 truncate text-body-2-medium text-text-primary">
        {model.model}
      </span>
      <span className="font-mono text-caption-1-regular tabular-nums text-text-tertiary">
        {model.tokens > 0 ? compactNumber(model.tokens) : "-"}
      </span>
      <span className="w-9 text-right text-caption-1-regular tabular-nums text-text-secondary">
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
      <div className="rounded-xl border border-border-button-default bg-background-secondary-default px-4 py-6 text-center">
        <p className="text-caption-1-regular text-text-tertiary">Loading usage...</p>
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
      <div className="rounded-xl border border-border-button-default bg-background-secondary-default px-4 py-6 text-center">
        <p className="text-body-2-medium text-text-primary">No model usage yet</p>
        <p className="mt-0.5 text-caption-1-regular text-text-secondary">
          Model consumption appears here once you run a task this cycle.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border-button-default bg-background-secondary-default px-4 py-3">
      {models.map((model) => (
        <ModelRow key={model.model} model={model} totalTokens={fleet.totalTokens} />
      ))}
      <div className="mt-2 flex items-center justify-between border-t border-separator-border pt-2.5">
        <span className="text-mono-label text-text-tertiary">tokens today</span>
        <span className="font-mono text-body-2-medium tabular-nums text-text-primary">
          {compactNumber(fleet.totalTokens)}
          {fleet.totalCost > 0 ? (
            <span className="ml-2 text-text-tertiary">${fleet.totalCost.toFixed(2)}</span>
          ) : null}
        </span>
      </div>
    </div>
  );
}
