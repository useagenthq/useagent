import type { RepoRef } from "@useagent/agent-client";
import type { Turn } from "./conversation";
import { type ForkSource, parseForkPrompt } from "./fork-prompt";
import { formatThreadMarkdown } from "./thread-export";
import { runTitle } from "./types";

/** Everything the new-thread composer needs to start a fork: the history up to
 * the chosen message and the source turn's repositories and model. */
export interface ForkDraft {
  readonly source: ForkSource;
  readonly title: string;
  readonly context: string;
  readonly repos: readonly RepoRef[];
  readonly engine: string;
  readonly model: string;
  readonly reasoningEffort: string | null;
}

/** The conversation cut at `runId`: every turn before it and the turn itself. */
export function turnsThrough(turns: readonly Turn[], runId: string): readonly Turn[] | null {
  const index = turns.findIndex((turn) => turn.run.id === runId);
  return index === -1 ? null : turns.slice(0, index + 1);
}

export function buildForkDraft(
  threadId: string,
  turns: readonly Turn[],
  runId: string,
  origin: string,
  canonicalTimeline: boolean,
): ForkDraft | null {
  const kept = turnsThrough(turns, runId);
  const last = kept?.at(-1);
  if (!kept || !last) return null;
  // A fork of a fork keeps the history its own first turn carried.
  const inherited = parseForkPrompt(kept[0].run.prompt)?.context;
  const own = formatThreadMarkdown({ threadId, turns: kept }, origin, canonicalTimeline);
  return {
    source: { threadId, turn: kept.length },
    title: runTitle(kept[0].run.prompt),
    context: inherited ? `${inherited}\n\n${own}` : own,
    repos: last.run.repo_specs,
    engine: last.run.engine,
    model: last.run.model,
    reasoningEffort: last.run.reasoning_effort ?? null,
  };
}

// The history is too large for a URL, so it rides sessionStorage to /agent/new
// in the same tab, keyed by the run it was cut at, and survives a reload there
// until the thread starts.
const STORAGE_PREFIX = "useagent:fork:";

export function stashForkDraft(key: string, draft: ForkDraft): boolean {
  try {
    window.sessionStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

export function readForkDraft(key: string): ForkDraft | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_PREFIX + key);
    const draft = raw ? (JSON.parse(raw) as ForkDraft) : null;
    return draft && typeof draft.context === "string" && draft.source ? draft : null;
  } catch {
    return null;
  }
}

export function discardForkDraft(key: string): void {
  try {
    window.sessionStorage.removeItem(STORAGE_PREFIX + key);
  } catch {
    // Unavailable storage holds nothing to discard.
  }
}
