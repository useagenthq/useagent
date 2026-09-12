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
import { cx } from "@/utils/cx";
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

/**
 * Glyph ink per tone. The emerald, amber, cyan and slate fills are bright in
 * the light themes, where the white glyph read 2.0 to 2.4:1; static-black is
 * the darkest neutral of every ramp, so it also holds on the dark overlays.
 */
const INK: Record<string, string> = {
  emerald: "text-static-black",
  amber: "text-static-black",
  cyan: "text-static-black",
  slate: "text-static-black",
};

export function toneClass(tone: string): string {
  return TONES[tone] ?? TONES.blue!;
}

export function iconFor(icon: string): React.ComponentType<{ className?: string }> {
  return ICONS[icon] ?? RiRobot2Line;
}

const GLYPH: Record<string, string> = {
  "size-8": "size-4",
  "size-10": "size-5",
  "size-14": "size-7",
  "size-16": "size-8",
};

/**
 * Flat, rounded, one color, one-ink glyph - the reference's avatar language.
 * State is one small dot in the theme's success/warning color; nothing else.
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
        "relative flex shrink-0 items-center justify-center rounded-full",
        toneClass(tone),
        INK[tone] ?? "text-text-white-0",
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
