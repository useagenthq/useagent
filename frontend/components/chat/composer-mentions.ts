/**
 * Pure logic for the composer "@" mention system - the parts with no React or
 * DOM so they unit-test in isolation (see composer-mentions.test.ts). The UI
 * hook + popover live in composer-mentions.tsx.
 *
 * The honest v1 mechanic: the composer is a plain textarea (no contentEditable
 * rich pills), so a mention lands as BOTH a text token the user can see/edit and
 * a structured record rendered as a removable chip above the input. On submit the
 * records become typed run-resource selections. The visible token remains in the
 * user's prompt, while server-fetched labels never gain prompt authority.
 *
 * Token shapes (single whitespace-free run each, so caret detection + best-effort
 * removal stay simple):
 *   skill  -> @skill/<name>
 *   thread -> @thread/<short-id>
 *   pr     -> @<owner>/<repo>#<number>
 *   file   -> @<owner>/<repo>:<path>
 */

import type { RunResourceSelection } from "@useagent/agent-client/wire";

export type MentionKind = "skill" | "thread" | "pr" | "file";

export type Mention =
  | { kind: "skill"; id: string; name: string; token: string }
  | { kind: "thread"; id: string; shortId: string; title: string; token: string }
  | { kind: "pr"; repo: string; number: number; title: string; token: string }
  | { kind: "file"; repo: string; path: string; revision: string | null; token: string };

// ---------------------------------------------------------------------------
// Token builders + identity
// ---------------------------------------------------------------------------

export function skillToken(name: string): string {
  return `@skill/${name}`;
}

export function threadToken(shortId: string): string {
  return `@thread/${shortId}`;
}

export function prToken(repo: string, num: number): string {
  return `@${repo}#${num}`;
}

export function fileToken(repo: string, path: string): string {
  return `@${repo}:${path}`;
}

/** Short, human-facing thread handle - the run id's leading segment. */
export function shortThreadId(id: string): string {
  return id.slice(0, 8);
}

/** Stable identity for dedupe + React keys (independent of the display token). */
export function mentionKey(m: Mention): string {
  switch (m.kind) {
    case "skill":
      return `skill:${m.id}`;
    case "thread":
      return `thread:${m.id}`;
    case "pr":
      return `pr:${m.repo}#${m.number}`;
    case "file":
      return `file:${m.repo}:${m.path}`;
  }
}

// Convenience constructors (each derives its own display token).
export function skillMention(id: string, name: string): Mention {
  return { kind: "skill", id, name, token: skillToken(name) };
}

export function threadMention(id: string, title: string): Mention {
  const shortId = shortThreadId(id);
  return { kind: "thread", id, shortId, title, token: threadToken(shortId) };
}

export function prMention(repo: string, num: number, title: string): Mention {
  return { kind: "pr", repo, number: num, title, token: prToken(repo, num) };
}

export function fileMention(repo: string, path: string, revision: string | null): Mention {
  return { kind: "file", repo, path, revision, token: fileToken(repo, path) };
}

// ---------------------------------------------------------------------------
// "@" trigger detection (caret + word boundary)
// ---------------------------------------------------------------------------

/**
 * Find the active "@" mention trigger ending at `caret`, or null. The "@" must
 * sit at a word boundary (start of text or right after whitespace), and the run
 * from it to the caret must contain no whitespace - a space ends the mention and
 * closes the popover. `query` is the text after "@" (the live typeahead filter);
 * `start` is the "@" index (where a picked token is spliced in).
 */
export function detectMentionTrigger(
  text: string,
  caret: number,
): { query: string; start: number } | null {
  const pos = Math.max(0, Math.min(caret, text.length));
  const upto = text.slice(0, pos);
  const at = upto.lastIndexOf("@");
  if (at === -1) return null;
  // Word boundary: start of text, or the char before "@" is whitespace.
  if (at > 0 && !/\s/.test(text[at - 1] as string)) return null;
  const query = upto.slice(at + 1);
  // Any whitespace between "@" and the caret means the mention is done/abandoned.
  if (/\s/.test(query)) return null;
  return { query, start: at };
}

// ---------------------------------------------------------------------------
// Token insert / remove (keep the text and the structured records in sync)
// ---------------------------------------------------------------------------

/**
 * Replace the "@query" span [start, caret) with `token ` (a trailing space so
 * the caret lands clear of the token, closing the popover). Returns the new text
 * and caret offset.
 */
export function insertMentionToken(
  text: string,
  start: number,
  caret: number,
  token: string,
): { text: string; caret: number } {
  const insert = `${token} `;
  const next = text.slice(0, start) + insert + text.slice(caret);
  return { text: next, caret: start + insert.length };
}

/**
 * Remove the FIRST exact occurrence of `token` (best-effort text sync when a chip
 * is removed), eating one trailing space we inserted with it. A token the user
 * already edited away is simply left alone.
 */
export function removeMentionToken(text: string, token: string): string {
  const idx = text.indexOf(token);
  if (idx === -1) return text;
  const before = text.slice(0, idx);
  let after = text.slice(idx + token.length);
  if (after.startsWith(" ")) after = after.slice(1);
  return before + after;
}

// ---------------------------------------------------------------------------
// Typed run-resource selections (authorized and revision-pinned by the server)
// ---------------------------------------------------------------------------

export function mentionsToRunResources(mentions: readonly Mention[]): RunResourceSelection[] {
  return mentions.flatMap((mention): RunResourceSelection[] => {
    switch (mention.kind) {
      case "skill":
        return [];
      case "thread":
        return [{
          kind: "thread",
          provider: "useagent",
          locator: { type: "thread", id: mention.id },
        }];
      case "pr":
        return [{
          kind: "code.change",
          provider: "github",
          locator: {
            type: "github.pull_request",
            repository: mention.repo,
            number: mention.number,
            revision: null,
          },
        }];
      case "file":
        return [{
          kind: "code.repository",
          provider: "github",
          locator: {
            type: "github.repository",
            repository: mention.repo,
            revision: mention.revision,
          },
        }];
    }
    return [];
  });
}

// ---------------------------------------------------------------------------
// Mention reducer (the structured records behind the chips)
// ---------------------------------------------------------------------------

export type MentionAction =
  | { type: "add"; mention: Mention }
  | { type: "remove"; key: string }
  | { type: "clear" };

export function mentionsReducer(state: Mention[], action: MentionAction): Mention[] {
  switch (action.type) {
    case "add": {
      const key = mentionKey(action.mention);
      if (state.some((m) => mentionKey(m) === key)) return state;
      return [...state, action.mention];
    }
    case "remove":
      return state.filter((m) => mentionKey(m) !== action.key);
    case "clear":
      return [];
  }
}
