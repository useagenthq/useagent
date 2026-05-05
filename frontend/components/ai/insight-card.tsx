import type { ComponentType } from "react";
import {
  RiArrowDownLine,
  RiArrowUpLine,
  RiSubtractLine,
} from "@remixicon/react";
import { cnExt as cn } from "@/utils/cn";

/**
 * Metric insight — a labelled micro-stat with a tone-colored delta, a one-line
 * body, and an optional inline sparkline. Ported from the AI library's
 * InsightCards onto AlignUI tokens.
 *
 * The sparkline is pure divs: bar heights are normalized from the `chart`
 * array (no chart lib), with the trailing bar at full opacity so the latest
 * point reads as "now".
 */

type IconComponent = ComponentType<{
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
}>;

type Tone = "up" | "down" | "flat";

const toneMeta: Record<Tone, { text: string; bar: string; icon: IconComponent }> =
  {
    up: {
      text: "text-success-base",
      bar: "bg-success-base",
      icon: RiArrowUpLine,
    },
    down: {
      text: "text-error-base",
      bar: "bg-error-base",
      icon: RiArrowDownLine,
    },
    flat: {
      text: "text-text-soft-400",
      bar: "bg-text-disabled-300",
      icon: RiSubtractLine,
    },
  };

export interface InsightCardProps {
  title: string;
  delta: string;
  tone: Tone;
  body: string;
  chart?: number[];
  className?: string;
}

function Sparkline({ data, barClass }: { data: number[]; barClass: string }) {
  const max = Math.max(...data, 1);
  return (
    <span className="flex h-7 items-end gap-[3px]" aria-hidden>
      {data.map((value, i) => (
        <span
          key={i}
          className={cn(
            "w-1 rounded-full",
            barClass,
            i === data.length - 1 ? "opacity-100" : "opacity-40",
          )}
          style={{ height: `${Math.max(4, Math.round((value / max) * 28))}px` }}
        />
      ))}
    </span>
  );
}

export function InsightCard({
  title,
  delta,
  tone,
  body,
  chart,
  className,
}: InsightCardProps) {
  const meta = toneMeta[tone];
  const ToneIcon = meta.icon;
  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-2xl border border-stroke-soft-200 bg-bg-white-0 p-4 shadow-regular-xs",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="text-mono-label text-text-soft-400">{title}</span>
        {chart && chart.length > 0 && (
          <Sparkline data={chart} barClass={meta.bar} />
        )}
      </div>
      <div className={cn("flex items-center gap-1", meta.text)}>
        <ToneIcon className="size-4 shrink-0" aria-hidden />
        <span className="text-title-h5 tabular-nums">{delta}</span>
      </div>
      <p className="text-paragraph-sm text-text-sub-600">{body}</p>
    </div>
  );
}
