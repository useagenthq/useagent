import {
  RiFileCopy2Line,
  RiGitMergeLine,
  RiGlobalLine,
  RiInformationLine,
  RiRobot2Line,
  RiTerminalBoxLine,
} from "@remixicon/react";
import type { RemixiconComponentType } from "@remixicon/react";

import { cx as cn } from "@/utils/cx";

export type SurfaceChoice = "desktop" | "terminal" | "artifacts" | "agents" | "diff" | "details";

// The rail is a resizable sub-viewport panel (viewport breakpoints can't
// describe it), so a container query on the switcher header collapses each
// surface pill to icon-only (label -> sr-only keeps the accessible name) once
// the strip is too narrow for up to 7 labels; scroll is the final fallback.
export const RAIL_TAB_LABEL_COLLAPSE = "@max-[40rem]:sr-only";

/** Rail chrome toggles (expand, collapse, open): quiet neutral icon buttons.
 *  The ghost variant is accent-tinted, which reads as a selected state next to the tabs. */
export const RAIL_ICON_BUTTON =
  "bg-transparent text-text-secondary hover:bg-background-secondary-hover hover:text-text-primary active:bg-background-tertiary-hover aria-pressed:bg-background-secondary-hover aria-pressed:text-text-primary";

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
  {
    id: "details",
    label: "Details",
    description: "Environment, task plan and usage.",
    icon: RiInformationLine,
  },
] as const;

/** Header label for the rail's ACTIVE tab: the chooser surfaces plus the
 *  non-chooser editor/workspace tabs (their labels live with the tab type). */
export function railTabLabelFor(
  railTab: SurfaceChoice | "editor" | "workspace" | null,
): string {
  if (railTab === null) return "Panels";
  const labels = {
    agents: "Agents",
    artifacts: "Files",
    diff: "Diff",
    editor: "Editor",
    workspace: "Workspace",
    terminal: "Terminal",
    desktop: "Desktop",
    details: "Details",
  } satisfies Record<Exclude<SurfaceChoice | "editor" | "workspace", null>, string>;
  return labels[railTab];
}

/** The rail's empty state: the thread's live facts as quiet chips, then the
 *  surfaces as one list of rows (icon tile, name, one line, state on the right),
 *  with the ones that have nothing yet grouped below instead of greyed out. */
export function SurfaceChooser({
  agentsAvailable,
  diffAvailable,
  facts = [],
  onSelect,
}: {
  agentsAvailable: boolean;
  diffAvailable: boolean;
  /** Short live facts about the thread ("3 files", "12 commands"). */
  facts?: readonly string[];
  onSelect: (surface: SurfaceChoice) => void;
}) {
  const waiting = (id: SurfaceChoice) =>
    (id === "diff" && !diffAvailable) || (id === "agents" && !agentsAvailable);
  const ready = SURFACES.filter((surface) => !waiting(surface.id));
  const later = SURFACES.filter((surface) => waiting(surface.id));
  return (
    <div className="flex h-full justify-center overflow-y-auto px-6 py-10">
      <div className="w-full max-w-md">
        <h2 className="sr-only">Open a panel</h2>
        {facts.length > 0 && (
          <ul className="mb-6 flex flex-wrap gap-1.5" aria-label="This thread">
            {facts.map((fact) => (
              <li
                key={fact}
                className="rounded-full border border-border-button-default bg-background-secondary-default px-2.5 py-1 text-caption-1-medium text-text-secondary"
              >
                {fact}
              </li>
            ))}
          </ul>
        )}
        <SurfaceRows surfaces={ready} onSelect={onSelect} />
        {later.length > 0 && (
          <>
            <p className="mt-6 mb-1 px-2 text-caption-1-medium text-text-tertiary">
              Appears when there is work
            </p>
            <SurfaceRows surfaces={later} waiting />
          </>
        )}
      </div>
    </div>
  );
}

function SurfaceRows({
  surfaces,
  waiting = false,
  onSelect,
}: {
  surfaces: readonly SurfaceOption[];
  waiting?: boolean;
  onSelect?: (surface: SurfaceChoice) => void;
}) {
  return (
    <div className="flex flex-col">
      {surfaces.map(({ id, label, description, unavailable, icon: Icon }) => (
        <button
          key={id}
          type="button"
          disabled={waiting}
          onClick={() => onSelect?.(id)}
          className={cn(
            "group flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent-500",
            waiting ? "cursor-default" : "hover:bg-background-secondary-hover",
          )}
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border-button-default bg-background-primary-default">
            <Icon className="size-4 text-text-secondary" aria-hidden />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-body-2-medium text-text-primary">{label}</span>
            <span className="block truncate text-caption-1-regular text-text-tertiary">{description}</span>
          </span>
          <span
            className={cn(
              "shrink-0 text-caption-1-regular",
              waiting ? "text-text-tertiary" : "text-text-secondary opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100",
            )}
          >
            {waiting ? unavailable?.replace(/\.$/, "") : "Open"}
          </span>
        </button>
      ))}
    </div>
  );
}

/** The chooser's live facts: commands run and files touched in this thread. */
export function threadFacts(steps: readonly { readonly kind: string }[]): string[] {
  const commands = steps.filter((step) => step.kind === "command").length;
  const files = steps.filter((step) => step.kind === "file").length;
  return [
    ...(commands > 0 ? [`${commands} command${commands === 1 ? "" : "s"} run`] : []),
    ...(files > 0 ? [`${files} file change${files === 1 ? "" : "s"}`] : []),
  ];
}
