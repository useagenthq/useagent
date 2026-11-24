type ComposerAction =
  | { kind: "send"; label: "Send" }
  | { kind: "steer"; label: "Queue" }
  | { kind: "stop"; label: "Stop this task" };

export function getComposerAction({
  running,
  hasDraft,
  canStop,
}: {
  running: boolean;
  hasDraft: boolean;
  canStop: boolean;
}): ComposerAction {
  // While a turn runs the draft queues behind it; Stop is the button only for a
  // caller that gives this composer the stop action (the running footer owns it otherwise).
  if (running && (hasDraft || !canStop)) return { kind: "steer", label: "Queue" };
  if (running) return { kind: "stop", label: "Stop this task" };
  return { kind: "send", label: "Send" };
}

/**
 * Compact now is offered only on a quiet thread: nothing running, pending or
 * queued (a queued gateway child counts, it holds the thread's lane), no
 * control request open, the composer unlocked, and the engine offering the
 * command.
 */
export function compactAvailable({
  running,
  pending,
  turnStatuses,
  controlOpen,
  locked,
  commands,
}: {
  running: boolean;
  pending: boolean;
  turnStatuses: readonly string[];
  controlOpen: boolean;
  locked: boolean;
  commands: readonly { name: string }[] | undefined;
}): boolean {
  return (
    !running &&
    !pending &&
    !turnStatuses.includes("queued") &&
    !controlOpen &&
    !locked &&
    (commands?.some((c) => c.name === "compact") ?? false)
  );
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
