"use client";

import { cnExt as cn } from "@/utils/cn";

/**
 * Slash-command "Choose Agent" machinery (HeyRico ref 2081778664228945957_1):
 * a popover of pixel-avatar agents shown when the composer input starts with
 * "/", plus the pink inline command chip the selection renders as. Presentational
 * — selecting an agent decorates the composer; it doesn't change the run payload.
 */

export type Agent = {
  id: string;
  name: string;
  tagline: string;
  color: string;
};

export const AGENTS: Agent[] = [
  { id: "explorer", name: "Explorer", tagline: "A new adventure", color: "#EC4899" },
  { id: "navigator", name: "Navigator", tagline: "Mapping the terrain", color: "#22A7F0" },
  { id: "pioneer", name: "Pioneer", tagline: "Charting unknown territories", color: "#7C3AED" },
  { id: "voyager", name: "Voyager", tagline: "Journeying through the cosmos", color: "#F97316" },
];

/** A small pixel-art-style avatar: a 3×3 block grid in the agent's color at
 * deterministic opacities. */
export function PixelAvatar({ color, className }: { color: string; className?: string }) {
  const cells = [0.55, 1, 0.7, 1, 0.85, 1, 0.7, 1, 0.55];
  return (
    <span
      className={cn("grid size-4 shrink-0 grid-cols-3 grid-rows-3 overflow-hidden rounded", className)}
      aria-hidden
    >
      {cells.map((o, i) => (
        <span key={i} style={{ backgroundColor: color, opacity: o }} />
      ))}
    </span>
  );
}

export function ChooseAgentPopover({
  query,
  onSelect,
  className,
}: {
  query: string;
  onSelect: (agent: Agent) => void;
  className?: string;
}) {
  const q = query.replace(/^\//, "").toLowerCase();
  const matches = AGENTS.filter((a) => a.name.toLowerCase().includes(q));
  if (matches.length === 0) return null;

  return (
    <div
      className={cn(
        "border-stroke-soft-200 bg-bg-white-0 shadow-regular-md w-full rounded-2xl border p-2",
        className,
      )}
    >
      <p className="text-mono-label text-text-soft-400 px-2 pb-1 pt-1.5">Choose Agent</p>
      {matches.map((a, i) => (
        <button
          key={a.id}
          type="button"
          onMouseDown={(e) => {
            e.preventDefault();
            onSelect(a);
          }}
          className={cn(
            "flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left transition-colors",
            i === 0 ? "bg-bg-weak-50" : "hover:bg-bg-weak-50",
          )}
        >
          <PixelAvatar color={a.color} />
          <span className="text-label-sm" style={{ color: a.color }}>
            {a.name}
          </span>
          <span className="text-paragraph-sm text-text-soft-400 truncate">
            {a.tagline}
          </span>
        </button>
      ))}
    </div>
  );
}

export function AgentChip({
  agent,
  onRemove,
}: {
  agent: Agent;
  onRemove?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onRemove}
      title="Remove agent"
      className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-0.5 text-label-sm"
      style={{ backgroundColor: `${agent.color}1F`, color: agent.color }}
    >
      /{agent.id}
    </button>
  );
}
