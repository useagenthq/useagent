// How a child of a turn is named for people, by what actually happened: a bot
// took the work in its own thread, the agent fanned out a native subagent, the
// agent opened a plain child thread, or it spawned a deferred session through the
// gateway. Shared by the inline fold, the Agents rail and the rail detail so the
// three surfaces never disagree. Pure; no React.

export type ChildKind = "subagent" | "bot_thread" | "child_thread" | "spawned_session";

const SINGULAR: Record<ChildKind, string> = {
  subagent: "subagent",
  bot_thread: "bot thread",
  child_thread: "child thread",
  spawned_session: "spawned session",
};

const ORDER: readonly ChildKind[] = ["subagent", "bot_thread", "child_thread", "spawned_session"];

/** The row caption: "Nova · bot thread" when the bot is known, else the kind. */
export function childKindLabel(kind: ChildKind, botName?: string | null): string {
  return kind === "bot_thread" && botName ? `${botName} · ${SINGULAR[kind]}` : SINGULAR[kind];
}

/** The fold header: "2 subagents, 1 bot thread". Zero counts are omitted. */
export function childGroupLabel(counts: Partial<Record<ChildKind, number>>): string {
  return ORDER.flatMap((kind) => {
    const count = counts[kind] ?? 0;
    if (count === 0) return [];
    return [`${count} ${count === 1 ? SINGULAR[kind] : `${SINGULAR[kind]}s`}`];
  }).join(", ");
}
