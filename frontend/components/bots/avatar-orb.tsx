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

const TONES: Record<string, string> = {
  blue: "from-sky-400 to-blue-600",
  violet: "from-indigo-400 to-violet-600",
  emerald: "from-emerald-400 to-teal-600",
  amber: "from-amber-400 to-orange-600",
  rose: "from-rose-400 to-red-600",
  cyan: "from-cyan-400 to-sky-600",
  fuchsia: "from-fuchsia-400 to-purple-600",
  slate: "from-slate-400 to-slate-600",
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

/**
 * Gradient orb with the bot's role icon. Working bots carry a pulsing presence
 * dot; bots waiting on you get an amber ring so the roster reads at a glance.
 */
export function AvatarOrb({
  tone,
  icon,
  state = "idle",
  size = "size-9",
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
        "relative flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br text-white shadow-sm",
        toneClass(tone),
        state === "attention" && "ring-2 ring-yellow-400/70 ring-offset-1 ring-offset-background-primary-default",
        size,
        className,
      )}
      aria-hidden
    >
      <Icon className={size === "size-10" || size === "size-14" ? "size-5" : "size-4"} />
      {state === "working" && (
        <span className="absolute -right-0.5 -bottom-0.5 size-2.5 animate-pulse rounded-full border-2 border-background-primary-default bg-lime-500" />
      )}
      {state === "attention" && (
        <span className="absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-background-primary-default bg-yellow-500" />
      )}
    </span>
  );
}
