import {
  RiBarChart2Line,
  RiCompass3Line,
  RiCustomerService2Line,
  RiGitPullRequestLine,
  RiMegaphoneLine,
  RiQuillPenLine,
  RiRobot2Line,
  RiSearchEyeLine,
  RiUserSearchLine,
} from "@remixicon/react";
import { Badge } from "@/components/base/badges/badge";
import { cx } from "@/utils/cx";
import { stateLabel } from "./roster-model";
import type { BotState } from "./types";

/**
 * Avatar fills come from the theme's state ramp, so a bot looks native in
 * every theme (Dusk gets Tokyo Night, Aura gets violet) with no raw palette.
 */
const TONES: Record<string, string> = {
  blue: "bg-primary-base",
  violet: "bg-feature-base",
  emerald: "bg-success-base",
  amber: "bg-warning-base",
  rose: "bg-error-base",
  cyan: "bg-verified-base",
  fuchsia: "bg-highlighted-base",
  slate: "bg-away-base",
};

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  robot: RiRobot2Line,
  code: RiGitPullRequestLine,
  research: RiSearchEyeLine,
  chart: RiBarChart2Line,
  megaphone: RiMegaphoneLine,
  sales: RiUserSearchLine,
  support: RiCustomerService2Line,
  pen: RiQuillPenLine,
  compass: RiCompass3Line,
};

export function toneClass(tone: string): string {
  return TONES[tone] ?? TONES.blue!;
}

export function iconFor(icon: string): React.ComponentType<{ className?: string }> {
  return ICONS[icon] ?? RiRobot2Line;
}

const GLYPH: Record<string, string> = {
  "size-5": "size-3",
  "size-8": "size-4",
  "size-10": "size-5",
  "size-14": "size-7",
  "size-16": "size-8",
};

/** The state in words beside a name: the dot alone is colour only. */
export function StateBadge({ state }: { state: BotState }) {
  const label = stateLabel(state);
  if (!label) return null;
  return <Badge color={state === "attention" ? "primary" : "neutral"}>{label}</Badge>;
}

/**
 * Flat, rounded, one color, white glyph - the reference's avatar language.
 * State is one small dot in the theme's success/warning color, paired with
 * the StateBadge wherever the name is shown.
 */
export function AvatarMark({
  tone,
  icon,
  state = "idle",
  size = "size-10",
  className,
}: {
  tone: string;
  icon: string;
  state?: BotState;
  size?: string;
  className?: string;
}) {
  const Icon = iconFor(icon);
  return (
    <span
      className={cx(
        "relative flex shrink-0 items-center justify-center rounded-full text-text-white-0",
        toneClass(tone),
        size,
        className,
      )}
      aria-hidden
    >
      <Icon className={GLYPH[size] ?? "size-5"} />
      {state !== "idle" && (
        <span
          className={cx(
            "absolute -right-0.5 -bottom-0.5 size-3 rounded-full border-2 border-bg-white-0",
            state === "working" ? "bg-success-base" : "bg-warning-base",
          )}
        />
      )}
    </span>
  );
}
