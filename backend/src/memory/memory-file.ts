/**
 * The sandbox memory FILE — pure shape + (de)serialization for the resident
 * agent's `/memory` skill file (`~/.skynet/memory.md`).
 *
 * Old skynet promised this file "persists across sessions, loaded at start,
 * synced back at task-end". The rebuild shipped the snapshot's skill text but not
 * the sync machinery, so a fresh thread (= fresh sandbox) read an EMPTY file. This
 * module + the store next to it MAKE THE PROMISE TRUE: the worker restores the
 * file at boot from the durable snapshot store (immediate, distillation-free) and
 * captures the agent's edits back at task end.
 *
 * File layout, split by {@link MEMORY_BODY_MARKER}:
 *   ┌ ABOVE ─ regenerated every restore, NEVER captured (so headers never nest):
 *   │   provenance + honesty + latency note, then the distilled team recall
 *   │   (reference only, may lag a few minutes behind freshly taught facts).
 *   ├ MARKER
 *   └ BELOW ─ the DURABLE BODY: the notes the agent records. This is what the
 *       store snapshots and what the next session restores, so it round-trips
 *       cleanly across sandboxes.
 *
 * Pure + dependency-free (only the MemoryScope type) so it unit-tests without a DB
 * or a sandbox.
 */
import type { MemoryScope } from "../db/schema";

/** Relative path under the sandbox HOME. The `/memory` skill points the agent
 *  here; the adapter restores/reads the same absolute `$HOME/.skynet/memory.md`. */
export const MEMORY_FILE_RELPATH = ".skynet/memory.md";

/** Separates the regenerated preamble from the durable body. Everything AFTER it
 *  round-trips (captured → restored); everything before is rebuilt each session
 *  and never captured, so provenance headers never stack up over time. */
export const MEMORY_BODY_MARKER =
  "<!-- SKYNET-MEMORY-BODY: your durable notes live below this line; edit freely and they persist across sessions -->";

/** Default byte budget for a restored file (the boot-restore stays small so it
 *  never dominates the agent's context). */
const DEFAULT_MAX_BYTES = 4096;

/** One team-memory pool's durable body, tagged with the scope it came from. */
export interface ScopedBody {
  readonly scope: MemoryScope;
  readonly body: string;
}

/** Just the recalled-item shape this module renders (a structural subset of
 *  ScopedRecall.items, so callers pass the recall straight through). */
export interface RecalledItem {
  readonly content: string;
  readonly sourceScope: MemoryScope;
}

export interface RestoreInput {
  /** ISO timestamp of this restore, injected by the caller (kept pure). */
  readonly restoredAt: string;
  /** Latest durable body per read pool, in priority order (personal first). */
  readonly bodies: readonly ScopedBody[];
  /** Distilled team recall for this turn (may be empty / null when memory has
   *  nothing yet or distillation still lags). Rendered as reference only. */
  readonly recall: { readonly items: readonly RecalledItem[] } | null;
  readonly maxBytes?: number;
}

/** Strip HTML comments + whitespace to decide if a body carries real content —
 *  an empty file or one holding only our hint comment must NOT be snapshotted. */
function stripToSignal(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, "").trim();
}

/** True when a captured body has content worth persisting (not blank / comment
 *  only). The finalize-capture path gates snapshots on this. */
export function hasMeaningfulBody(body: string): boolean {
  return stripToSignal(body).length > 0;
}

/**
 * Everything BELOW the body marker — the durable notes to snapshot at task end.
 * Falls back to the whole file when the marker is absent (an agent that rewrote
 * the file wholesale), minus a leading regenerated header if one is recognizable.
 */
export function extractMemoryBody(fileContent: string): string {
  const idx = fileContent.indexOf(MEMORY_BODY_MARKER);
  if (idx >= 0) return fileContent.slice(idx + MEMORY_BODY_MARKER.length).trim();
  return fileContent.trim();
}

/** Merge per-pool bodies into one region: dedupe identical bodies (a fact present
 *  in both personal and org shows once), label each block only when more than one
 *  distinct pool contributes. */
function mergeBodies(bodies: readonly ScopedBody[]): string {
  const seen = new Set<string>();
  const blocks: { scope: MemoryScope; body: string }[] = [];
  for (const { scope, body } of bodies) {
    const trimmed = body.trim();
    if (!hasMeaningfulBody(trimmed)) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    blocks.push({ scope, body: trimmed });
  }
  const [first] = blocks;
  if (!first) return "";
  if (blocks.length === 1) return first.body;
  return blocks.map((b) => `<!-- from ${b.scope} memory -->\n${b.body}`).join("\n\n");
}

/**
 * Render the full memory file to restore for a fresh session: the provenance +
 * honesty header, the distilled recall (reference), the marker, then the merged
 * durable body — bounded to `maxBytes` (the body is truncated first, then the
 * recall, so the honest header always survives).
 */
export function buildMemoryDigest(input: RestoreInput): string {
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
  const multiScope = new Set((input.recall?.items ?? []).map((i) => i.sourceScope)).size > 1;

  const header =
    `# Team memory (restored)\n\n` +
    `Restored from team memory at ${input.restoredAt}.\n` +
    `This file is loaded from the Skynet team-memory service at the start of every ` +
    `session and captured back when the task ends, so notes you record here persist ` +
    `across sessions and sandboxes. Cross-session continuity is immediate through this ` +
    `file; a freshly taught fact can take a few minutes to also surface in semantic ` +
    `search recall. Edit freely: everything below the marker is captured back at task end.\n`;

  const recallLines: string[] = [];
  for (const item of input.recall?.items ?? []) {
    const content = item.content.trim();
    if (!content) continue;
    const tag = multiScope ? `[${item.sourceScope}] ` : "";
    recallLines.push(`- ${tag}${content}`);
  }
  const recallSection =
    recallLines.length > 0
      ? `\n## Recent team recall (reference, may be stale)\n${recallLines.join("\n")}\n`
      : `\n## Recent team recall\n(no distilled team memory surfaced for this session yet)\n`;

  const body = mergeBodies(input.bodies);
  const bodySection = body
    ? `\n${body}\n`
    : `\n<!-- Record durable notes below; they are saved to your team memory when the task ends. -->\n`;

  // Assemble, then enforce the byte budget by trimming the softest parts first
  // (body, then recall) so the provenance header is never the thing that is cut.
  const assemble = (recallPart: string, bodyPart: string): string =>
    `${header}${recallPart}\n${MEMORY_BODY_MARKER}\n${bodyPart}`;

  let out = assemble(recallSection, bodySection);
  if (Buffer.byteLength(out, "utf8") <= maxBytes) return out;

  // 1) Trim the body region to fit.
  const overheadNoBody = Buffer.byteLength(assemble(recallSection, "\n"), "utf8");
  if (overheadNoBody < maxBytes && body) {
    const room = maxBytes - overheadNoBody - 20;
    const clipped = clipToBytes(body, Math.max(0, room));
    out = assemble(recallSection, `\n${clipped}\n(truncated)\n`);
    if (Buffer.byteLength(out, "utf8") <= maxBytes) return out;
  }

  // 2) Still over budget (huge recall): drop the recall detail entirely.
  out = assemble(`\n## Recent team recall\n(trimmed to fit)\n`, bodySection);
  if (Buffer.byteLength(out, "utf8") <= maxBytes) return out;

  // 3) Last resort: header + marker only (never drop the honest header).
  return `${header}\n${MEMORY_BODY_MARKER}\n`;
}

/** Clip `text` to at most `maxBytes` UTF-8 bytes without splitting a character. */
function clipToBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (Buffer.byteLength(text.slice(0, mid), "utf8") <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo);
}
