/**
 * Markdown -> Slack mrkdwn conversion for outbound replies.
 *
 * Agent replies are GitHub-flavored Markdown, but Slack message text fields use
 * "mrkdwn": *bold* (single asterisk), _italic_, ~strike~, <url|label> links, no
 * headings, no `[text](url)`. Posting raw Markdown renders `**bold**` as literal
 * asterisks and `## heading` as a literal hash - the user-visible bug this fixes.
 *
 * PORTED from the user's QM bot: a reference implementation/src/slack/mrkdwn.ts (toSlackMrkdwn),
 * verified by a reference implementation/test/slack-mrkdwn.test.ts. Kept the full markdown-conversion
 * pipeline and the mass-mention safety defuser (so an agent reply that literally
 * contains an encoded `<!channel>` cannot broadcast to a real workspace). Dropped
 * only the `@user`-mention arming (setMentionIndex/armUserMentions) - it needs a
 * workspace user directory we do not wire here - and the inbound/block-kit helpers
 * (resolveMentionsInText, stripMention, slackSectionBlocks) unrelated to this path.
 */

const BOLD_SENTINEL = String.fromCharCode(1);
const STASH_OPEN = String.fromCharCode(0);

const MASS_MENTION = /<!(here|channel|everyone)(?:\|[^>]*)?>/gi;

/** Defuse Slack's encoded broadcast forms (<!here>/<!channel>/<!everyone>) so an
 *  agent reply that quotes one cannot ping a whole channel. */
export function neutralizeMassMentions(text: string): string {
  return text.replace(MASS_MENTION, (_m, word: string) => `@​${word.toLowerCase()}`);
}

/**
 * Convert Markdown to Slack mrkdwn. Code spans and fenced blocks are stashed
 * first and restored last, so nothing inside them is transformed.
 */
export function toSlackMrkdwn(md: string): string {
  if (!md) return md;
  const stash: string[] = [];
  const keep = (s: string): string => `${STASH_OPEN}${stash.push(s) - 1}${STASH_OPEN}`;

  let text = md.replace(/\r\n/g, "\n");

  text = text.replace(/```[\s\S]*?```/g, keep);
  text = text.replace(/`[^`\n]+`/g, keep);
  text = neutralizeMassMentions(text);

  text = reformatTables(text, keep);

  text = text.replace(/!?\[([^\]]*)\]\(\s*<?([^()\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (_m, label, url) =>
    keep(label ? `<${url}|${label}>` : `<${url}>`),
  );

  text = text.replace(/<(?:https?:\/\/|mailto:|[@#!])[^<>\n\x00]*>/g, keep);
  text = text.replace(/(?<![a-zA-Z0-9])https?:\/\/[^\s<>|\x00\x01]+/g, (url) => {
    const kept = trimUrlTail(url);
    return keep(`<${kept}>`) + url.slice(kept.length);
  });

  text = text.replace(/^[ \t]*([-*_])\1{2,}[ \t]*$/gm, "──────────");

  text = text.replace(/\*\*(?!\s)([^\n]+?)(?<!\s)\*\*/g, `${BOLD_SENTINEL}$1${BOLD_SENTINEL}`);
  text = text.replace(/__(?!\s)([^\n]+?)(?<!\s)__/g, `${BOLD_SENTINEL}$1${BOLD_SENTINEL}`);

  text = text.replace(/~~(?!\s)([^\n]+?)(?<!\s)~~/g, "~$1~");

  text = text.replace(
    /^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*#*$/gm,
    (_m, h) => `${BOLD_SENTINEL}${(h as string).replaceAll(BOLD_SENTINEL, "")}${BOLD_SENTINEL}`,
  );

  text = text.replace(/^([ \t]*)[-*+][ \t]+/gm, "$1• ");

  text = text.replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![*\w])/g, "$1_$2_");

  text = text.replaceAll(BOLD_SENTINEL, "*");
  text = text.replace(new RegExp(`${STASH_OPEN}(\\d+)${STASH_OPEN}`, "g"), (_m, i) => stash[Number(i)] ?? "");

  return text;
}

function trimUrlTail(url: string): string {
  const openerOf: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  let end = url.length;
  while (end > 0) {
    const ch = url[end - 1]!;
    if ("*_~.,;:!?'\"".includes(ch)) {
      end--;
      continue;
    }
    const opener = openerOf[ch];
    if (opener) {
      const head = url.slice(0, end);
      const opens = head.split(opener).length - 1;
      const closes = head.split(ch).length - 1;
      if (closes > opens) {
        end--;
        continue;
      }
    }
    break;
  }
  return url.slice(0, end);
}

const stripEdgePipes = (t: string): string => t.replace(/^\s*\|/, "").replace(/\|\s*$/, "");
const splitTableRow = (line: string): string[] =>
  stripEdgePipes(line.trim())
    .split("|")
    .map((c) => c.trim());
const looksLikeTableRow = (line: string | undefined): boolean =>
  line != null && line.includes("|") && line.trim().length > 0;

function isTableDelimiter(line: string | undefined): boolean {
  if (line == null || !line.includes("-")) return false;
  const cells = stripEdgePipes(line.trim()).split("|");
  return cells.length >= 1 && cells.every((c) => /^\s*:?-+:?\s*$/.test(c));
}

function renderAlignedTable(rows: string[][]): string {
  const ncols = Math.max(...rows.map((r) => r.length));
  const widths = Array.from({ length: ncols }, (_, c) => Math.max(1, ...rows.map((r) => (r[c] ?? "").length)));
  const fmtRow = (r: string[]): string =>
    widths
      .map((w, c) => (r[c] ?? "").padEnd(w))
      .join(" | ")
      .trimEnd();
  const sep = widths.map((w) => "-".repeat(w)).join("-+-");
  const [head, ...body] = rows;
  return [fmtRow(head ?? []), sep, ...body.map(fmtRow)].join("\n");
}

/** GFM tables have no mrkdwn equivalent, so render them as an aligned monospace
 *  block (which Slack does render). */
function reformatTables(text: string, keep: (s: string) => string): string {
  if (!text.includes("|")) return text;
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (looksLikeTableRow(lines[i]) && isTableDelimiter(lines[i + 1])) {
      const rows: string[][] = [splitTableRow(lines[i]!)];
      let j = i + 2;
      for (; j < lines.length && looksLikeTableRow(lines[j]); j++) rows.push(splitTableRow(lines[j]!));
      out.push(keep("```\n" + renderAlignedTable(rows) + "\n```"));
      i = j - 1;
    } else {
      out.push(lines[i]!);
    }
  }
  return out.join("\n");
}
