import { RiOpenaiFill } from "@remixicon/react";
import Link from "next/link";
import { AsteriskMark } from "@/components/foundations/brand/asterisk-mark";
import { NumberTicker } from "@/components/shared/number-ticker";
import { cnExt } from "@/utils/cn";
import { Panel, PanelHeading } from "./panel";
import { estimatedTokens } from "@/utils/format";

const METER_BARS = 16;
type MeterTone = "opus" | "gpt" | "sonnet";

/** Segmented vertical usage meter — mirrors the settings UsageMeter. */
function SegMeter({ value, tone }: { value: number; tone: MeterTone }) {
  const filled = Math.round(METER_BARS * value);
  const fill =
    tone === "opus" ? "bg-orange-400" : tone === "sonnet" ? "bg-blue-400" : "bg-text-strong-950";
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

type Model = {
  mark: "asterisk" | "openai";
  markClassName: string;
  name: string;
  value: number;
  tone: MeterTone;
};

const MODELS: Model[] = [
  { mark: "asterisk", markClassName: "text-orange-500", name: "Opus 4.7", value: 0.8, tone: "opus" },
  { mark: "openai", markClassName: "text-text-strong-950", name: "GPT 5.5", value: 0.95, tone: "gpt" },
  { mark: "asterisk", markClassName: "text-blue-500", name: "Sonnet 4.5", value: 0.35, tone: "sonnet" },
];

function ModelRow({ mark, markClassName, name, value, tone }: Model) {
  return (
    <div className="flex items-center gap-2.5 py-1.5">
      {mark === "asterisk" ? (
        <AsteriskMark className={cnExt("size-[18px] shrink-0", markClassName)} />
      ) : (
        <RiOpenaiFill className={cnExt("size-[18px] shrink-0", markClassName)} aria-hidden />
      )}
      <span className="min-w-0 flex-1 truncate text-label-sm text-text-strong-950">{name}</span>
      <span className="font-mono text-label-xs tabular-nums text-text-soft-400">
        {Math.round(value * 100)}%
      </span>
      <SegMeter value={value} tone={tone} />
    </div>
  );
}

type BarTone = "amber" | "red" | "blue";

/** Horizontal resource meter (RAM / Swap / Disk). Static mock values. */
function MeterBar({
  label,
  right,
  value,
  tone,
}: {
  label: string;
  right: string;
  value: number;
  tone: BarTone;
}) {
  const fill =
    tone === "amber" ? "bg-warning-base" : tone === "red" ? "bg-error-base" : "bg-information-base";
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-mono-label text-text-sub-600">{label}</span>
        <span className="font-mono text-label-xs tabular-nums text-text-soft-400">{right}</span>
      </div>
      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-bg-soft-200">
        <div className={cnExt("h-full rounded-full", fill)} style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}

/**
 * The "Limits" row: model burn (real token estimate + mock meters) and a mock
 * machine snapshot. Meter/machine figures are presentational; only the "tokens
 * today" headline is derived from live run data.
 */
export function LimitsRow({ runCount }: { runCount: number }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel>
        <PanelHeading>Models · burn</PanelHeading>
        <div className="divide-y divide-stroke-soft-200">
          {MODELS.map((model) => (
            <ModelRow key={model.name} {...model} />
          ))}
        </div>
        <div className="mt-4 border-t border-stroke-soft-200 pt-4">
          <p className="font-mono text-title-h5 font-semibold tabular-nums text-text-strong-950">
            ≈ <NumberTicker value={runCount} format={estimatedTokens} />
          </p>
          <p className="mt-1 text-mono-label text-text-soft-400">tokens today · estimated</p>
        </div>
      </Panel>

      <Panel>
        <PanelHeading
          right={
            <Link
              href="/settings"
              className="inline-flex items-center rounded-md bg-bg-weak-50 px-2 py-0.5 font-mono text-[0.6875rem] text-text-sub-600 outline-none transition-colors hover:bg-bg-soft-200 focus-visible:ring-2 focus-visible:ring-stroke-strong-950"
            >
              snapshot-2026-07-24
            </Link>
          }
        >
          Machine
        </PanelHeading>
        <div className="space-y-4">
          <MeterBar label="RAM" right="11G / 15.2G" value={72} tone="amber" />
          <MeterBar label="Swap" right="4G / 4G" value={100} tone="red" />
          <MeterBar label="Disk" right="670G / 1T" value={67} tone="blue" />
        </div>
      </Panel>
    </div>
  );
}
