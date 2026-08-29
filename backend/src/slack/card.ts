/**
 * Block Kit RUN CARD for a Slack-started run. A Slack-originated run posts ONE
 * structured card (not a bare ack + plain text) that is UPDATED in place as the
 * run progresses: header + status, a context row (model + repos), an "Open in
 * useAgent" url button, and the final answer appended when the run settles.
 *
 * PURE by design (no I/O, no Slack calls) so the card shape is unit-testable with
 * fixtures; the outbox (post_card/update_card) and the watcher own delivery. The
 * caller always keeps `text` as the notification/fallback string, so a Block Kit
 * post/update that fails can degrade to a plain-text reply and never lose the
 * answer.
 */
import type { RunStatus } from "../db/schema";
import type { RepoRef } from "../github/repo-ref";
import { toSlackMrkdwn } from "./mrkdwn";

/** Card lifecycle phase, mapped from the run status the card is rendered for. */
export type CardPhase = "queued" | "running" | "completed" | "failed";

/** Everything the pure builder needs. All strings pre-cleaned; no I/O here. */
export interface RunCardInput {
  /** The task title (derived from the prompt - first line). */
  readonly title: string;
  readonly phase: CardPhase;
  readonly model: string;
  /** Repos the run is bound to (clean "owner/name" + optional branch). */
  readonly repoSpecs: readonly RepoRef[];
  /** The run's web session URL (FRONTEND_ORIGIN/session/<threadId>). */
  readonly webUrl: string;
  /** Short "working: <step>" line while running (optional; omitted otherwise). */
  readonly workingStep?: string;
  /** The final answer (agent Markdown), set when the run settles. */
  readonly answer?: string;
  /** True for the card that closes a NATIVE stream: the streamed message body
   *  already carries the reply, so the card stays chrome-only (linked title,
   *  context row, button) and never repeats the answer. */
  readonly omitAnswer?: boolean;
}

// Block Kit length caps (Slack docs): a header plain_text tops out at 150 chars,
// a section mrkdwn field at 3000, a button text at 75. Truncate defensively so a
// long title/answer never gets the whole card rejected as invalid_blocks.
const HEADER_CAP = 148;
const SECTION_CAP = 2900;
const CONTEXT_CAP = 2000;

/** Status emoji + human label for each phase (Pluto-style indicator). */
const PHASE_META: Record<CardPhase, { emoji: string; label: string }> = {
  queued: { emoji: ":hourglass_flowing_sand:", label: "Queued" },
  running: { emoji: ":gear:", label: "Running" },
  completed: { emoji: ":white_check_mark:", label: "Completed" },
  failed: { emoji: ":x:", label: "Failed" },
};

/** Map a run's terminal/lifecycle status onto a card phase. */
export function phaseForStatus(status: RunStatus): CardPhase {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "running") return "running";
  return "queued";
}

/** The run's web session URL: FRONTEND_ORIGIN + "/session/" + threadId. Pure -
 *  the origin is passed in (callers read env.FRONTEND_ORIGIN). */
export function sessionUrl(origin: string, threadId: string): string {
  return `${origin.replace(/\/+$/, "")}/session/${threadId}`;
}

/** Truncate to `max` chars on a whole-grapheme-ish boundary, adding an ellipsis. */
function truncate(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return t.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

/** Derive a task title from a (cleaned) prompt: first non-empty line, truncated. */
export function deriveTitle(prompt: string): string {
  const firstLine = prompt
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return truncate(firstLine ?? "Run", HEADER_CAP);
}

/** Render the repo binding as "owner/repo · branch", with "+N more" past the first. */
function repoSummary(repoSpecs: readonly RepoRef[]): string | null {
  if (repoSpecs.length === 0) return null;
  const first = repoSpecs[0]!;
  const head = first.branch ? `${first.repo} · ${first.branch}` : first.repo;
  const extra = repoSpecs.length - 1;
  return extra > 0 ? `${head}  +${extra} more` : head;
}

/** The context row text: model, then repos when bound. Single mrkdwn string. */
function contextText(model: string, repoSpecs: readonly RepoRef[]): string {
  const repos = repoSummary(repoSpecs);
  const parts = [`*Model:* ${model}`];
  if (repos) parts.push(`*Repo:* ${repos}`);
  return truncate(parts.join("   ·   "), CONTEXT_CAP);
}

/** The header line: status emoji + label (literal), then the title as a BOLD
 *  LINK to the run's web session. Only the title is escaped - a `:emoji:`
 *  shortcode must keep its colons and underscores intact, and the phase label
 *  is fixed chrome. A mrkdwn link label additionally cannot contain `>` or `|`
 *  (they terminate the link), so those become spaces. */
function headerText(input: RunCardInput): string {
  const meta = PHASE_META[input.phase];
  const prefix = `${meta.emoji} ${meta.label}: `;
  const title = escapeMrkdwn(truncate(input.title, Math.max(1, HEADER_CAP - prefix.length)))
    .replace(/[>|]/g, " ");
  return `${prefix}<${input.webUrl}|${title}>`;
}

/**
 * Build the Block Kit `blocks` array + a plain-text notification/fallback string
 * for a run card. Pure: the same input always yields the same blocks. The
 * returned `text` is what a plain-text reply would say if Block Kit is rejected,
 * so the answer is never lost.
 */
export function buildRunCard(input: RunCardInput): { blocks: unknown[]; text: string } {
  const meta = PHASE_META[input.phase];
  const blocks: unknown[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*${headerText(input)}*` },
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: contextText(input.model, input.repoSpecs) }],
    },
  ];

  // A short "working: <step>" context line while running (progress feedback).
  if (input.phase === "running" && input.workingStep) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `_working: ${escapeMrkdwn(truncate(input.workingStep, CONTEXT_CAP))}_` }],
    });
  }

  // The "Open in useAgent" url button (no interactivity handler needed).
  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "Open in useAgent", emoji: true },
        url: input.webUrl,
        action_id: "open_in_useagent",
      },
    ],
  });

  // The final answer, appended when the run settles (mrkdwn, capped).
  const answerText = answerSection(input);
  if (answerText) {
    blocks.push({ type: "divider" });
    blocks.push({ type: "section", text: { type: "mrkdwn", text: answerText } });
  }

  return { blocks, text: fallbackText(input, meta.label) };
}

/** The settled answer as a capped mrkdwn section, or null while non-terminal
 *  (or when the streamed message body already carries the reply). */
function answerSection(input: RunCardInput): string | null {
  if (input.omitAnswer) return null;
  if (input.phase !== "completed" && input.phase !== "failed") return null;
  const answer = input.answer?.trim() ? toSlackMrkdwn(input.answer.trim()) : "";
  if (input.phase === "completed") {
    return truncate(answer || "Done.", SECTION_CAP);
  }
  // Failed: warn with the reason when present.
  return truncate(answer ? `:warning: Run failed: ${answer}` : ":warning: Run failed.", SECTION_CAP);
}

/** The plain-text notification/fallback string mirrored from the card contents. */
function fallbackText(input: RunCardInput, statusLabel: string): string {
  const answer = answerSection(input);
  if (answer) return answer; // terminal: the answer IS the message body
  const repos = repoSummary(input.repoSpecs);
  const bits = [`${statusLabel}: ${input.title}`, input.model];
  if (repos) bits.push(repos);
  return bits.join(" - ");
}

/** Escape mrkdwn control chars in card CHROME (title/step) so a stray `*`/`_`
 *  in a task title cannot break the card layout. The answer body is deliberately
 *  NOT escaped: it goes through toSlackMrkdwn to render agent Markdown. */
function escapeMrkdwn(text: string): string {
  return text.replace(/[*_~`]/g, (c) => `​${c}`);
}
