"use client";

import { ThinkingOrb, type OrbState } from "@/components/base/thinking-orb";
import { useReportWorking } from "@/components/shell/working-signal";
import { cnExt as cn } from "@/utils/cn";

/**
 * The shared "orb pill" — a 20px ThinkingOrb + a status word inside a rounded-full
 * hairline pill (the Jakub Antalík thinking-orbs demo presentation: "Working…." /
 * "Shaping…." capsules). One primitive for every inline orb surface (boot
 * indicator, live working pill). The 64px orb preset is reserved for a dedicated
 * full-screen boot — which this app doesn't have — so everything inline is 20px.
 *
 * `state` selects the animation and should be mapped to what's actually happening
 * (working = booting an engine, shaping = provisioning a sandbox, composing = the
 * model streaming, searching = running a command/tool). The label is 13px muted,
 * per the refined UI type scale, and inherits the global -0.15px tracking.
 */
export function OrbPill({
  state = "working",
  label,
  className,
  ariaLabel,
}: {
  state?: OrbState;
  label: string;
  className?: string;
  ariaLabel?: string;
}) {
  // An OrbPill is only ever on screen while the engine is booting or working, so
  // its lifetime IS the "working" window - report it so the brand mark pulses.
  useReportWorking();
  return (
    <div
      role="status"
      aria-label={ariaLabel ?? label}
      className={cn(
        "border-stroke-soft-200 bg-bg-white-0 shadow-regular-md inline-flex items-center gap-1.5 rounded-full border py-1 pl-1 pr-3",
        className,
      )}
    >
      <ThinkingOrb state={state} size={20} aria-hidden />
      <span className="text-text-sub-600 text-[13px] leading-none">{label}</span>
    </div>
  );
}
