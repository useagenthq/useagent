import type { ComponentType } from "react";
import {
  RiArrowDownLine,
  RiArrowUpLine,
  RiSubtractLine,
} from "@remixicon/react";
import { cx } from "@/utils/cx";

/**
 * Metric insight — a labelled micro-stat with a tone-colored delta, a one-line
 * body, and an optional inline sparkline. Ported from the AI library's
 * InsightCards onto our tokens.
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
      text: "text-lime-600",
      bar: "bg-lime-500",
      icon: RiArrowUpLine,
    },
    down: {
      text: "text-text-error-primary",
      bar: "bg-red-500",
      icon: RiArrowDownLine,
    },
    flat: {
      text: "text-text-tertiary",
      bar: "bg-foreground-icon-quaternary",
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
          className={cx(
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
      className={cx(
        "flex flex-col gap-2 rounded-2xl border border-border-button-default bg-background-primary-default p-4 shadow-card",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="text-mono-label text-text-tertiary">{title}</span>
        {chart && chart.length > 0 && (
          <Sparkline data={chart} barClass={meta.bar} />
        )}
      </div>
      <div className={cx("flex items-center gap-1", meta.text)}>
        <ToneIcon className="size-4 shrink-0" aria-hidden />
        <span className="text-title-3-medium font-semibold tracking-[-0.1px] tabular-nums">{delta}</span>
      </div>
      <p className="text-body-2-regular text-text-secondary">{body}</p>
    </div>
  );
}
