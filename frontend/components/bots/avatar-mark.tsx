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
import { Orb, type OrbProps, type OrbTone, ORB_TONES } from "@/components/base/orb/orb";
import { cx } from "@/utils/cx";
import { stateLabel } from "./roster-model";
import type { BotState } from "./types";

/**
 * A bot's tone on the wire names one of the orb palette's vivid pairs, the
 * same in every theme, so a bot is recognizable wherever it appears. `prism`
 * is the iridescent ball.
 */
const TONES: ReadonlySet<string> = new Set<OrbTone>(ORB_TONES);

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

/** The Orb behind a bot tone: its palette pair, or the prism variant; unknown names fall back to blue. */
export function botOrb(tone: string): Pick<OrbProps, "tone" | "variant"> {
  if (tone === "prism") return { variant: "prism" };
  return { tone: TONES.has(tone) ? (tone as OrbTone) : "blue" };
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
 * A glossy orb in the bot's tone with its role glyph centered on it - the one
 * avatar language for every place a bot appears. The glyph's ink (white on a
 * deep ball, black on a bright one) is fixed per identity tone. State is one
 * small dot in the theme's
 * success/warning color, paired with the StateBadge wherever the name is shown.
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
    <Orb {...botOrb(tone)} size={size} className={className} aria-hidden>
      <Icon className={GLYPH[size] ?? "size-5"} />
      {state !== "idle" && (
        <span
          className={cx(
            "absolute -right-0.5 -bottom-0.5 size-3 rounded-full border-2 border-bg-white-0",
            state === "working" ? "bg-success-base" : "bg-warning-base",
          )}
        />
      )}
    </Orb>
  );
}
