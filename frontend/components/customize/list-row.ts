/**
 * Shared helpers for the Customize list pages (Playbooks, Skills, Automations,
 * Reviews, Secrets, Knowledge, Memory). Pure + framework-free so every list
 * renders the same row grammar without a forced component abstraction - the
 * rows differ too much in content to share one primitive, but they share these
 * two rules: suppress a description that only restates its title, and demote
 * rest-state action furniture to a hover/focus reveal.
 */

/**
 * A kind label some descriptions are prefixed with ("Playbook: <title>",
 * "Skill - <title>"). Stripped before the redundancy check so the classic
 * "description repeats the title with a label prefix" case is caught.
 */
const LABEL_PREFIX = /^(playbook|skill|automation|guide|workflow|procedure)\s*[:.\-]\s*/i;

function normalize(text: string): string {
  return text
    .trim()
    .replace(LABEL_PREFIX, "")
    .replace(/[\s.]+$/, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/**
 * True when a list item's description adds nothing over its title: it is empty,
 * equals the title, or equals the title behind a kind-label prefix (all
 * case-insensitive, trailing punctuation ignored). Deliberately an equals check
 * after prefix-stripping rather than a raw `startsWith`, so an informative
 * description that merely opens with the title (e.g. "pdf-tools - fill PDF
 * forms") is kept, while "Playbook: <title>" and a bare restatement are dropped.
 */
export function isRedundantDescription(title: string, description: string): boolean {
  const desc = normalize(description);
  if (!desc) return true;
  const name = normalize(title);
  return name.length > 0 && desc === name;
}

/** The description to render for a row, or null when it is redundant/empty. */
export function visibleDescription(title: string, description: string): string | null {
  const trimmed = description.trim();
  if (!trimmed) return null;
  return isRedundantDescription(title, description) ? null : trimmed;
}

/**
 * Rest-state action furniture (Run now, Discuss/GitHub, trash, edit/delete)
 * demoted to a hover/focus reveal - the house pattern (see conversation.tsx,
 * message-bubble.tsx). Put `group/customize` on the row and this on the action wrapper (or
 * the button itself). Keyboard users still get it via focus-within; the reveal
 * is opacity-only so the row never reflows.
 */
export const REVEAL_ON_HOVER =
  "opacity-100 transition-opacity duration-150 sm:opacity-0 sm:group-hover/customize:opacity-100 focus-within:opacity-100";
