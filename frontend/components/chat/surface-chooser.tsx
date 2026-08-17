import {
  RiFileCopy2Line,
  RiGitMergeLine,
  RiGlobalLine,
  RiRobot2Line,
  RiTerminalBoxLine,
} from "@remixicon/react";
import type { RemixiconComponentType } from "@remixicon/react";

import { cn } from "@/utils/cn";

export type SurfaceChoice = "desktop" | "terminal" | "artifacts" | "agents" | "diff";

interface SurfaceOption {
  readonly id: SurfaceChoice;
  readonly label: string;
  readonly description: string;
  readonly icon: RemixiconComponentType;
}

const SURFACES: readonly SurfaceOption[] = [
  {
    id: "desktop",
    label: "Browser",
    description: "Open a local app or URL.",
    icon: RiGlobalLine,
  },
  {
    id: "terminal",
    label: "Terminal",
    description: "Start a shell in this workspace.",
    icon: RiTerminalBoxLine,
  },
  {
    id: "artifacts",
    label: "Files",
    description: "Browse files and artifacts.",
    icon: RiFileCopy2Line,
  },
  {
    id: "diff",
    label: "Diff",
    description: "Available when a real patch exists.",
    icon: RiGitMergeLine,
  },
  {
    id: "agents",
    label: "Agents",
    description: "Watch subagents and workflows run.",
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
      <div className="w-full max-w-md">
        <div className="text-center">
          <h2 className="text-label-lg text-text-strong-950">Open a surface</h2>
          <p className="mt-1 text-paragraph-sm text-text-soft-400">
            Choose what to show in the right panel.
          </p>
        </div>
        <div className="mt-5 grid grid-cols-2 gap-2.5">
          {SURFACES.map(({ id, label, description, icon: Icon }) => {
            const disabled =
              (id === "diff" && !diffAvailable) || (id === "agents" && !agentsAvailable);
            return (
              <button
                key={id}
                type="button"
                disabled={disabled}
                onClick={() => onSelect(id)}
                className={cn(
                  "min-h-32 rounded-xl border border-stroke-soft-200 bg-bg-white-0 p-4 text-left outline-none transition-colors hover:bg-bg-weak-50 focus-visible:ring-2 focus-visible:ring-primary-base",
                  disabled && "cursor-not-allowed opacity-40 hover:bg-bg-white-0",
                )}
              >
                <Icon className="size-5 text-text-sub-600" aria-hidden />
                <span className="mt-4 block text-label-md text-text-strong-950">{label}</span>
                <span className="mt-1 block text-paragraph-sm leading-5 text-text-soft-400">
                  {description}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
