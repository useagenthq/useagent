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

/** The Orb behind a bot tone: its palette pair, or the prism variant; unknown names fall back to blue. */
export function botOrb(tone: string): Pick<OrbProps, "tone" | "variant"> {
  if (tone === "prism") return { variant: "prism" };
  return { tone: TONES.has(tone) ? (tone as OrbTone) : "blue" };
}

/** The state in words beside a name: the dot alone is colour only. */
export function StateBadge({ state }: { state: BotState }) {
  const label = stateLabel(state);
  if (!label) return null;
  return <Badge color={state === "attention" ? "primary" : "neutral"}>{label}</Badge>;
}

/**
 * A bot's face: a soft-gloss orb in its tone with two white dot eyes - the one
 * avatar language for every place a bot appears. The stored `icon` still names
 * the bot's role on the wire but is not drawn; the color is the identity.
 * State is one small dot in the theme's success/warning color, paired with the
 * StateBadge wherever the name is shown.
 */
export function AvatarMark({
  tone,
  state = "idle",
  size = "size-10",
  className,
}: {
  tone: string;
  /** Kept on the wire and accepted here so every caller stays one line; not drawn. */
  icon?: string;
  state?: BotState;
  size?: string;
  className?: string;
}) {
  return (
    <Orb {...botOrb(tone)} size={size} className={className} face aria-hidden>
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
