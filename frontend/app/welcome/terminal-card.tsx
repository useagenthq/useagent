import {
  RiBox3Line,
  RiSettings3Line,
  RiFlowChart,
  RiGlobalLine,
  RiRocketLine,
} from "@remixicon/react";
import type { ComponentType } from "react";

import { cnExt } from "@/utils/cn";

type IconComponent = ComponentType<{
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
}>;

const LINES: { icon: IconComponent; text: string }[] = [
  { icon: RiFlowChart, text: "skynet launch openclaw" },
  { icon: RiBox3Line, text: "installing openclaw..." },
  { icon: RiSettings3Line, text: "configuring model..." },
  { icon: RiGlobalLine, text: "adding web tools..." },
  { icon: RiRocketLine, text: "openclaw is running" },
];

export interface TerminalCardProps {
  /** `compact` shrinks padding + type for the modal's art header. */
  size?: "default" | "compact";
  /** Merged onto the root so callers can override corners/border/shadow. */
  className?: string;
}

/**
 * The mock "skynet launch" terminal: traffic-light dots over five monospace
 * log lines with small leading icons. Reused at a smaller `compact` size inside
 * the "Connect your apps" modal art header.
 */
export function TerminalCard({ size = "default", className }: TerminalCardProps) {
  const compact = size === "compact";
  return (
    <div
      className={cnExt(
        "border border-stroke-soft-200 bg-bg-white-0",
        compact ? "rounded-xl p-3.5" : "rounded-2xl p-4 shadow-regular-md",
        className,
      )}
    >
      <div className={cnExt("flex items-center gap-1.5", compact ? "mb-3" : "mb-4")}>
        <span className="size-3 rounded-full bg-red-500" />
        <span className="size-3 rounded-full bg-yellow-400" />
        <span className="size-3 rounded-full bg-green-500" />
      </div>
      <ul className={cnExt("flex flex-col", compact ? "gap-2.5" : "gap-3.5")}>
        {LINES.map(({ icon: Icon, text }) => (
          <li key={text} className="flex items-center gap-2.5">
            <Icon
              className={cnExt(
                "shrink-0 text-text-soft-400",
                compact ? "size-3.5" : "size-4",
              )}
              aria-hidden
            />
            <span
              className={cnExt(
                "font-mono text-text-sub-600",
                compact ? "text-paragraph-xs" : "text-paragraph-sm",
              )}
            >
              {text}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
