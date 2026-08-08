"use client";

import { RiErrorWarningLine, RiTerminalLine } from "@remixicon/react";
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
  /** Argument/input hint the provider supplied (e.g. "[files]"), shown after the name. */
  input?: string | null;
};

/** The command-picker's honest render status (mirrors CommandCatalogState.status). */
export type CommandPickerStatus = "loading" | "unavailable" | "error" | "ready";

/** The picker's section label from the provider source - the ACTUAL provider, not a guess. */
export function commandSourceLabel(source?: string): string {
  switch ((source ?? "").toLowerCase()) {
    case "claude":
      return "Claude commands";
    case "codex":
      return "Codex commands";
    case "opencode":
      return "OpenCode commands";
    default:
      return "Commands";
  }
}

/** The composer text a picked command inserts. Native commands are invoked VERBATIM: the
 *  provider receives exactly `/name <args>` as an ordinary prompt (no client-side rename or
 *  translation), so this is just the leading `/name ` with the cursor left for arguments. */
export function slashInsertText(name: string): string {
  return `/${name} `;
}

/** Parse composer text into a TYPED native-command intent, ONLY when the leading `/token`
 *  is actually a command in the active catalog. This is what turns a picked/typed command
 *  into the explicit `{name, args}` intent sent to the run API (the backend re-validates it) -
 *  so a `/token` that is NOT an advertised command stays an ordinary prompt and keeps its
 *  context, instead of the old "any leading slash skips context" behavior. Returns null when
 *  the text is not a `/known-command ...`. `args` is everything after the command token. */
export function parseCommandIntent(
  text: string,
  commands: SlashCommand[],
): { name: string; args: string } | null {
  const m = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text.trimStart());
  if (!m) return null;
  const name = m[1]!;
  if (!commands.some((c) => c.name === name)) return null;
  return { name, args: m[2] ?? "" };
}

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

/** Stable option id for aria-activedescendant wiring on the composer textarea. */
export const commandOptionId = (name: string) => `slashcmd-opt-${name}`;

export function SlashCommandPopover({
  matches,
  highlight,
  onSelect,
  status = "ready",
  source,
  className,
}: {
  matches: SlashCommand[];
  highlight: number;
  onSelect: (command: SlashCommand) => void;
  /** Honest catalog state - drives loading/unavailable/error rows vs the command list. */
  status?: CommandPickerStatus;
  /** Provider source for the section label (Claude/Codex/OpenCode commands). */
  source?: string;
  className?: string;
}) {
  const header = commandSourceLabel(source);
  // A muted/error status row so absence, loading, and failure read honestly instead of nothing.
  const statusRow =
    status === "loading" ? (
      <p className="text-paragraph-xs text-text-soft-400 px-2 py-2" role="status">
        Loading commands…
      </p>
    ) : status === "error" ? (
      <p className="text-paragraph-xs text-error-base px-2 py-2 flex items-center gap-1.5" role="alert">
        <RiErrorWarningLine className="size-3.5 shrink-0" aria-hidden />
        Couldn&apos;t load commands - keep typing to send as text.
      </p>
    ) : status === "unavailable" ? (
      <p className="text-paragraph-xs text-text-soft-400 px-2 py-2" role="status">
        No native commands for this session.
      </p>
    ) : matches.length === 0 ? (
      <p className="text-paragraph-xs text-text-soft-400 px-2 py-2" role="status">
        No matching commands.
      </p>
    ) : null;

  return (
    <div
      className={cn(
        "border-stroke-soft-200 bg-bg-white-0 shadow-regular-md w-full rounded-2xl border p-2",
        className,
      )}
    >
      <p className="text-mono-label text-text-soft-400 px-2 pb-1 pt-1.5" id="slashcmd-label">
        {header}
      </p>
      <div className="max-h-72 overflow-y-auto" role="listbox" aria-labelledby="slashcmd-label">
        {statusRow}
        {status === "ready" &&
          matches.map((c, i) => (
            <button
              key={c.name}
              type="button"
              role="option"
              id={commandOptionId(c.name)}
              aria-selected={i === highlight}
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
              {c.input && (
                <span className="text-paragraph-xs text-text-soft-400 shrink-0 font-mono">
                  {c.input}
                </span>
              )}
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
