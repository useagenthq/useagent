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
 * commands); "@" files and "$" skills are NOT typed affordances here today, so
 * they are never advertised. An explicit caller placeholder always wins.
 */
export function composerPlaceholder({
  explicit,
  agentSlash,
  commandCount,
}: {
  explicit?: string;
  agentSlash: boolean;
  commandCount: number;
}): string {
  if (explicit !== undefined) return explicit;
  if (agentSlash) return "Ask anything, / for agents";
  if (commandCount > 0) return "Ask anything, / for commands";
  return "Ask anything...";
}
