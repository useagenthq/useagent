"use client";

import { RiTerminalLine } from "@remixicon/react";
import { cnExt as cn } from "@/utils/cn";

/**
 * Slash-command autocomplete for the reply composer — the engine's real
 * command list (GET /command on the thread's resident opencode server, via the
 * live-proxy), surfaced opencode-TUI-style while the first token is typed.
 * Selection just completes the text; the prompt is sent unchanged.
 */

export type SlashCommand = {
  name: string;
  description: string | null;
};

/** Prefix matches first, then substring matches; capped for the popover. */
export function filterCommands(
  commands: SlashCommand[],
  query: string,
  cap = 8,
): SlashCommand[] {
  const q = query.toLowerCase();
  const prefix = commands.filter((c) => c.name.toLowerCase().startsWith(q));
  const rest = commands.filter(
    (c) => !c.name.toLowerCase().startsWith(q) && c.name.toLowerCase().includes(q),
  );
  return [...prefix, ...rest].slice(0, cap);
}

export function SlashCommandPopover({
  matches,
  highlight,
  onSelect,
  className,
}: {
  matches: SlashCommand[];
  highlight: number;
  onSelect: (command: SlashCommand) => void;
  className?: string;
}) {
  if (matches.length === 0) return null;

  return (
    <div
      className={cn(
        "border-stroke-soft-200 bg-bg-white-0 shadow-regular-md w-full rounded-2xl border p-2",
        className,
      )}
    >
      <p className="text-mono-label text-text-soft-400 px-2 pb-1 pt-1.5">Commands</p>
      <div className="max-h-72 overflow-y-auto">
        {matches.map((c, i) => (
          <button
            key={c.name}
            type="button"
            // mousedown (not click) so the textarea never loses focus.
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(c);
            }}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left transition-colors",
              i === highlight ? "bg-bg-weak-50" : "hover:bg-bg-weak-50",
            )}
          >
            <RiTerminalLine className="text-text-sub-600 size-4 shrink-0" aria-hidden />
            <span className="text-label-sm text-text-strong-950 shrink-0 font-mono">
              /{c.name}
            </span>
            {c.description && (
              <span className="text-paragraph-xs text-text-soft-400 truncate">
                {c.description}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
