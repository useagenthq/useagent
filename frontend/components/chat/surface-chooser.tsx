import {
  RiFileCopy2Line,
  RiGitMergeLine,
  RiGlobalLine,
  RiRobot2Line,
  RiTerminalBoxLine,
} from "@remixicon/react";
import type { RemixiconComponentType } from "@remixicon/react";

import { cx as cn } from "@/utils/cx";

export type SurfaceChoice = "desktop" | "terminal" | "artifacts" | "agents" | "diff";

interface SurfaceOption {
  readonly id: SurfaceChoice;
  readonly label: string;
  readonly description: string;
  /** Shown instead of the description while the surface is gated off. */
  readonly unavailable?: string;
  readonly icon: RemixiconComponentType;
}

const SURFACES: readonly SurfaceOption[] = [
  {
    id: "desktop",
    label: "Browser",
    description: "Watch and control the live desktop.",
    icon: RiGlobalLine,
  },
  {
    id: "terminal",
    label: "Terminal",
    description: "A shell inside the workspace.",
    icon: RiTerminalBoxLine,
  },
  {
    id: "artifacts",
    label: "Files",
    description: "Everything this thread has produced.",
    icon: RiFileCopy2Line,
  },
  {
    id: "diff",
    label: "Diff",
    description: "Review this thread's code changes.",
    unavailable: "No patch yet.",
    icon: RiGitMergeLine,
  },
  {
    id: "agents",
    label: "Agents",
    description: "Follow subagents as they work.",
    unavailable: "No subagents yet.",
    icon: RiRobot2Line,
  },
] as const;

export function SurfaceChooser({
  agentsAvailable,
  diffAvailable,
  onSelect,
}: {
  agentsAvailable: boolean;
  diffAvailable: boolean;
  onSelect: (surface: SurfaceChoice) => void;
}) {
  return (
    <div className="flex h-full items-center justify-center overflow-y-auto p-6">
      <div className="w-full max-w-sm">
        <h2 className="sr-only">Open a surface</h2>
        <div className="flex flex-col gap-2.5">
          {SURFACES.map(({ id, label, description, unavailable, icon: Icon }) => {
            const disabled =
              (id === "diff" && !diffAvailable) || (id === "agents" && !agentsAvailable);
            return (
              <button
                key={id}
                type="button"
                disabled={disabled}
                onClick={() => onSelect(id)}
                className={cn(
                  "flex w-full items-center gap-3.5 rounded-xl border border-border-button-default bg-background-primary-default px-4 py-3.5 text-left outline-none transition-colors hover:bg-background-primary-hover focus-visible:ring-2 focus-visible:ring-accent-500",
                  disabled && "cursor-not-allowed opacity-40 hover:bg-background-primary-default",
                )}
              >
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-background-secondary-default">
                  <Icon className="size-4.5 text-text-secondary" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-body-medium text-text-primary">{label}</span>
                  <span className="mt-0.5 block text-body-2-regular leading-5 text-text-tertiary">
                    {description}
                  </span>
                </span>
                {disabled && unavailable && (
                  <span className="shrink-0 text-caption-1-regular text-text-tertiary">
                    {unavailable}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
