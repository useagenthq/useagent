/**
 * Split a long mrkdwn reply into sequential Slack messages instead of
 * truncating it.
 *
 * PORTED from a reference bot's `split_message` (reference-eval
 * src/kiro_crew/slack/format.py:361): same 3,900-char per-message bound
 * (`SLACK_MSG_LIMIT = 3900` - "API rejects above ~4000"), same boundary-seeking
 * cuts, same `_(continued…)_` marker on non-final chunks, and the same
 * first-message-is-the-head / followups-into-the-thread delivery shape
 * (handler.py `_safe_final_update`). Two deliberate improvements over the
 * source:
 *   - cuts prefer PARAGRAPH boundaries (a reference implementation cuts at the last newline);
 *   - fenced code blocks survive the split: a fence is treated as one atomic
 *     segment, and when a block alone exceeds the bound it is closed at the cut
 *     and reopened (language tag included) at the head of the next message, so
 *     every posted chunk renders valid mrkdwn.
 */

/** Per-message character bound (a reference implementation SLACK_MSG_LIMIT, format.py:332). */
export const SLACK_MSG_LIMIT = 3900;

/** Appended to every non-final chunk (a reference implementation CONTINUATION, format.py:334). */
const CONTINUATION = "\n\n_(continued…)_";

const FENCE_LINE = /^\s*```(\S*)\s*$/;

/** A paragraph of prose, or one whole fenced code block (fence lines included). */
interface Segment {
  readonly text: string;
  /** Set for a fenced block: the opener's language tag ("" when none). */
  readonly fenceLang: string | null;
}

/** Split into paragraphs on blank lines, keeping each fenced block whole. */
function segment(text: string): Segment[] {
  const out: Segment[] = [];
  let paragraph: string[] = [];
  let block: string[] | null = null; // open fenced block, opener included
  let blockLang = "";

  const endParagraph = (): void => {
    const t = paragraph.join("\n").trim();
    if (t) out.push({ text: t, fenceLang: null });
    paragraph = [];
  };

  for (const line of text.split("\n")) {
    const fence = FENCE_LINE.exec(line);
    if (block) {
      block.push(line);
      if (fence) {
        out.push({ text: block.join("\n"), fenceLang: blockLang });
        block = null;
      }
    } else if (fence) {
      endParagraph();
      block = [line];
      blockLang = fence[1] ?? "";
    } else if (line.trim() === "") {
      endParagraph();
    } else {
      paragraph.push(line);
    }
  }
  if (block) out.push({ text: block.join("\n"), fenceLang: blockLang }); // unclosed fence
  endParagraph();
  return out;
}

/** Hard-slice a run of text (a single line with no cut points) into raw parts. */
function slice(text: string, budget: number): string[] {
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += budget) parts.push(text.slice(i, i + budget));
  return parts;
}

/** Split one oversized segment on line boundaries; fenced blocks are closed at
 *  each cut and reopened with their language tag on the next part. */
function splitSegment(seg: Segment, budget: number): string[] {
  const open = seg.fenceLang !== null ? "```" + seg.fenceLang : "";
  const close = seg.fenceLang !== null ? "```" : "";
  // Room each part needs for its own fence wrapper.
  const inner = Math.max(1, budget - (open.length + close.length + 2));
  const lines =
    seg.fenceLang !== null
      ? seg.text.split("\n").filter((l) => !FENCE_LINE.test(l)) // re-wrapped below
      : seg.text.split("\n");

  const parts: string[] = [];
  let current: string[] = [];
  let len = 0;
  const flush = (): void => {
    if (current.length === 0) return;
    const body = current.join("\n");
    parts.push(seg.fenceLang !== null ? `${open}\n${body}\n${close}` : body);
    current = [];
    len = 0;
  };
  for (const raw of lines) {
    for (const line of raw.length <= inner ? [raw] : slice(raw, inner)) {
      if (len + line.length + 1 > inner) flush();
      current.push(line);
      len += line.length + 1;
    }
  }
  flush();
  return parts;
}

/**
 * Split `text` into an ordered sequence of Slack-postable messages, each at
 * most `limit` chars, cutting on paragraph/code-fence boundaries and keeping
 * fenced blocks renderable in every chunk. Returns `[text]` when it fits.
 */
export function chunkSlackText(text: string, limit = SLACK_MSG_LIMIT): string[] {
  if (text.length <= limit) return [text];
  // Every chunk reserves room for the continuation marker (the last chunk just
  // runs slightly short); the floor keeps progress for degenerate tiny limits
  // (a reference bot's max(., 1) termination guard, format.py:379).
  const budget = Math.max(1, limit - CONTINUATION.length);

  const chunks: string[] = [];
  let current = "";
  const push = (piece: string): void => {
    if (!piece) return;
    if (current && current.length + 2 + piece.length <= budget) {
      current += "\n\n" + piece;
      return;
    }
    if (current) chunks.push(current);
    current = piece;
  };

  for (const seg of segment(text)) {
    if (seg.text.length <= budget) push(seg.text);
    else for (const part of splitSegment(seg, budget)) push(part);
  }
  if (current) chunks.push(current);

  return chunks.map((c, i) => (i < chunks.length - 1 ? c + CONTINUATION : c));
}
