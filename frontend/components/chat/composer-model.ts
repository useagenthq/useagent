type ComposerAction =
  | { kind: "send"; label: "Send" }
  | { kind: "steer"; label: "Steer" }
  | { kind: "stop"; label: "Stop this run" };

export function getComposerAction({
  running,
  hasDraft,
  canStop,
}: {
  running: boolean;
  hasDraft: boolean;
  canStop: boolean;
}): ComposerAction {
  if (running && hasDraft) return { kind: "steer", label: "Steer" };
  if (running && canStop) return { kind: "stop", label: "Stop this run" };
  return { kind: "send", label: "Send" };
}

/**
 * Honest default placeholder: hint ONLY affordances this composer actually has.
 * "/" is real (agent picker on hero, command autocomplete when a catalog holds
 * commands); "@" is advertised only when the mention popover is enabled, and
 * "a bot" only when bots exist in this org. An explicit caller placeholder always
 * wins; `compact` (narrow screens) drops the hints so the line never wraps.
 */
export function composerPlaceholder({
  explicit,
  lead = "Ask anything",
  agentSlash,
  commandCount,
  mentions = false,
  bots = false,
  compact = false,
}: {
  explicit?: string;
  lead?: string;
  agentSlash: boolean;
  commandCount: number;
  mentions?: boolean;
  bots?: boolean;
  compact?: boolean;
}): string {
  if (explicit !== undefined) return explicit;
  if (agentSlash) return `${lead}, / for agents`;
  const hints = [
    ...(commandCount > 0 ? ["/ for commands"] : []),
    ...(mentions ? [bots ? "@ for context or a bot" : "@ for context"] : []),
  ];
  if (compact || hints.length === 0) return `${lead}...`;
  return `${lead}, ${hints.join(", ")}`;
}
