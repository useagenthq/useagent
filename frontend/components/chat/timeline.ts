// Interleaved turn timeline — the TRUE-ORDER projection of a live-or-settled turn.
//
// The delta channel concatenates every narration burst into one blob and the tool
// rows settle into a separate disclosure, so a live turn reads as N stacked "let
// me…" paragraphs with all the work hidden until it settles (user-reported,
// unreadable). This rebuilds the turn opencode-style: narration burst → the tool
// rows that followed it → next burst → …, from the native store's ordered frames.
//
// Ordering is MESSAGE-anchored, never raw-seq: a tool part upserts to its
// COMPLETION seq (running→completed re-emits a higher seq), so sorting by the
// frame's current seq would dump every tool after all the text. Instead each
// opencode step is one message (step-start → text → tools → step-finish); we order
// messages by their min seq (the stable step-start anchor) and, within a message,
// put the narration text before its tools in call order (ApiStep.idx).

import { asRecord, deriveTrace, type ApiStep } from "./types";
import { nativeOf } from "./native-ids";
import type { NativeSnapshot } from "./native-store";

/** A canonical context marker — a typed row (skill.loaded / context.retrieved)
 *  rendered in the SHARED timeline grammar, not a parallel context pane. */
export type TimelineMarker =
  | {
      readonly kind: "skill";
      /** True when the pinned instruction set was a playbook (labels the row). */
      readonly playbook: boolean;
      readonly name: string;
      readonly version: number;
      readonly hash: string;
    }
  | {
      readonly kind: "context";
      readonly source: string; // "memory" | "knowledge" | …
      readonly itemCount: number;
      readonly query: string | null;
    }
  | {
      /** A memory WRITE-path chip (provider skynet-memory): remember / correct /
       *  forget, or the honest failure of one. Reads (memory.searched) render as
       *  a plain context marker instead. */
      readonly kind: "memory";
      /** "search" appears only with failed:true (a read-path outage chip -
       *  successful searches render as context markers instead). */
      readonly op: "remember" | "correct" | "forget" | "search";
      readonly scope: "org" | "personal";
      readonly failed: boolean;
      /** remember only: true when the write was an idempotent no-op replay. */
      readonly reconciled: boolean;
    };

/** One node of the interleaved timeline: a context marker, a narration burst, or
 *  a tool row. */
export type TimelineNode =
  | { kind: "marker"; key: string; marker: TimelineMarker }
  | { kind: "text"; key: string; text: string }
  | { kind: "tool"; key: string; step: ApiStep };

/**
 * Parse a skynet-lane native frame (skill.loaded / context.retrieved) into a
 * typed timeline marker. Returns null for any other frame — an UNKNOWN skynet
 * eventType renders safely as nothing (never a crash), per the canonical-marker
 * contract.
 */
function parseMarker(eventType: string, payload: unknown): TimelineMarker | null {
  const p = asRecord(payload);
  if (!p) return null;
  if (eventType === "skill.loaded") {
    return {
      kind: "skill",
      // `kind` in the payload is the substrate kind ("skill" | "playbook"); a
      // pre-kind or malformed frame defaults to a plain skill label.
      playbook: p.kind === "playbook",
      name: typeof p.name === "string" ? p.name : "skill",
      version: typeof p.version === "number" ? p.version : 1,
      hash: typeof p.contentHash === "string" ? p.contentHash : "",
    };
  }
  // The knowledge gateway emits `knowledge.retrieved` (provider
  // skynet-knowledge); memory emits `context.retrieved` (provider skynet).
  // Both are context markers — the vocabulary split was an integration bug
  // (recorded but never rendered) caught by external audit. The memory-tool
  // read path (`memory.searched`, provider skynet-memory) joins the same
  // context grammar: "Recalled N items from memory".
  if (
    eventType === "context.retrieved" ||
    eventType === "knowledge.retrieved" ||
    eventType === "memory.searched"
  ) {
    return {
      kind: "context",
      source:
        typeof p.source === "string"
          ? p.source
          : eventType === "knowledge.retrieved"
            ? "knowledge"
            : "memory",
      itemCount: typeof p.itemCount === "number" ? p.itemCount : 0,
      query: typeof p.query === "string" ? p.query : null,
    };
  }
  // Memory write-path chips (frozen contract, memory-tools.ts MEMORY_EVENTS):
  // l0_accepted/updated/deleted are the success chips; memory.failed is the
  // honest failure (never emitted alongside a success). `memory.l1_indexed` is
  // defined upstream but UNUSED today (L1 distillation is async on the memory
  // service and unobserved during a turn) — it falls through to null safely.
  if (
    eventType === "memory.l0_accepted" ||
    eventType === "memory.updated" ||
    eventType === "memory.deleted" ||
    eventType === "memory.failed"
  ) {
    const failed = eventType === "memory.failed";
    const op =
      p.op === "correct" || p.op === "forget" || p.op === "search"
        ? p.op
        : eventType === "memory.updated"
          ? "correct"
          : eventType === "memory.deleted"
            ? "forget"
            : "remember";
    return {
      kind: "memory",
      op,
      scope: p.scope === "personal" ? "personal" : "org",
      failed,
      reconciled: p.reconciled === true,
    };
  }
  return null;
}

/** A text part's accumulated text, or null when the payload carries none. */
function partText(payload: unknown): string | null {
  const o = asRecord(payload);
  const t = o?.text;
  return typeof t === "string" && t.trim() ? t : null;
}

/**
 * A pure-narration pseudo-step, NOT a real tool. The adapter emits the final
 * assistant answer as a synthetic `task` step and bare "Thinking…" placeholders;
 * both fall through `deriveTrace` to the base fallback (verb "Thinking", no
 * accent). That text is already rendered from the native text frames, so it must
 * not also appear as a tool row (it double-rendered the final answer otherwise).
 */
function isNarration(step: ApiStep): boolean {
  const t = deriveTrace(step);
  return t.accent === null && t.glyph === "task" && t.verb === "Thinking";
}

/**
 * Build the ordered timeline for a turn, or null when the run carries no native
 * frames (the caller falls back to the delta-narration + worklog rendering).
 *
 * `live` keeps the sandbox boot rows (the pre-session gap signal) while the run is
 * live and drops them once settled — matching the worklog's boot filter.
 */
export function buildTimeline(
  native: NativeSnapshot,
  live: boolean,
): TimelineNode[] | null {
  const { nativeFrames } = native;
  if (nativeFrames.length === 0) return null;

  // Child (subagent) sessions: the store keys these off a step's stamped
  // childSessionID, but a `task`-tool fanout never stamps one — the parent linkage
  // only lives on the session lifecycle FRAMES (parentSessionId). Union both so
  // subagent narration is attributed to its own pane regardless of spawn path.
  const childSessions = new Set<string>(native.childSessionIds);
  for (const f of nativeFrames) {
    if (f.native.parentSessionId && f.native.sessionId) childSessions.add(f.native.sessionId);
  }

  // Message order key = min seq per messageId (the step-start anchor: step-start is
  // never revised, so this stays stable while text streams and tools bump their
  // completion seq). partId → messageId lets a tool/subtask step borrow its
  // message order even when its code_json.native omits messageID (subtask parts do).
  const msgOrderKey = new Map<string, number>();
  const partMessage = new Map<string, string>();
  // Assistant STEP messages emit a step/tool/subtask/reasoning part; a bare text
  // message (injected team-memory context, the echoed user prompt) never does —
  // that is the discriminator that keeps non-narration text out of the timeline.
  const stepMessages = new Set<string>();
  for (const f of nativeFrames) {
    const mid = f.native.messageId;
    if (!mid) continue;
    const prev = msgOrderKey.get(mid);
    if (prev === undefined || f.seq < prev) msgOrderKey.set(mid, f.seq);
    if (f.native.partId) partMessage.set(f.native.partId, mid);
    const t = f.eventType;
    if (
      t.startsWith("part.step") ||
      t.startsWith("part.tool") ||
      t.startsWith("part.subtask") ||
      t.startsWith("part.reasoning")
    )
      stepMessages.add(mid);
  }

  type Ranked = { node: TimelineNode; k0: number; k1: number; k2: number };
  const ranked: Ranked[] = [];

  // Canonical context markers (skynet lane): skill.loaded + context.retrieved.
  // Emitted at run START (lowest seqs), so they LEAD the turn (k0 below the boot
  // sentinel of -1) — "Loaded skill X · Recalled N memories" as the turn's header.
  // Rendered as typed rows in this shared grammar (MarkerRow), never a parallel
  // context pane. Reconnect replays them from the durable native lane like any
  // other frame. An unknown skynet eventType parses to null → rendered as nothing.
  for (const f of nativeFrames) {
    if (
      f.provider !== "skynet" &&
      f.provider !== "skynet-knowledge" &&
      f.provider !== "skynet-memory"
    )
      continue;
    const marker = parseMarker(f.eventType, f.payload);
    if (!marker) continue;
    ranked.push({
      node: { kind: "marker", key: f.eventId, marker },
      k0: -2,
      k1: 0,
      k2: f.seq, // skill.loaded (seq 0) before context.retrieved (seq 1)
    });
  }

  // Narration bursts — root-session, assistant-step messages only. One frame per
  // text partId (the store keeps the latest revision), each rendered as its own
  // progressive-markdown block; separate bursts stay separate paragraphs.
  for (const f of nativeFrames) {
    if (!f.eventType.startsWith("part.text")) continue;
    const sid = f.native.sessionId;
    if (sid && childSessions.has(sid)) continue; // subagent chatter → its own pane
    const mid = f.native.messageId;
    if (!mid || !stepMessages.has(mid)) continue; // context / user prompt text
    const text = partText(f.payload);
    if (!text) continue;
    ranked.push({
      node: { kind: "text", key: f.native.partId ?? f.eventId, text },
      k0: msgOrderKey.get(mid) ?? f.seq,
      k1: 0, // narration precedes its step's tools
      k2: f.seq,
    });
  }

  // Tool rows — from the enriched ApiStep projection (output/exit/diff, memoized by
  // ToolStepRow). A step borrows its message order via its partId; boot/lifecycle
  // rows carry no message and own the pre-session gap (live only).
  for (const step of native.steps) {
    if (step.kind === "done") continue;
    if (isNarration(step)) continue; // rendered from text frames, not as a row
    if (deriveTrace(step).accent === "boot") {
      if (!live) continue;
      ranked.push({ node: { kind: "tool", key: step.id, step }, k0: -1, k1: 1, k2: step.idx });
      continue;
    }
    const ids = nativeOf(step);
    const mid = (ids?.partID && partMessage.get(ids.partID)) || ids?.messageID || null;
    ranked.push({
      node: { kind: "tool", key: step.id, step },
      k0: mid ? msgOrderKey.get(mid) ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER,
      k1: 1,
      k2: step.idx,
    });
  }

  ranked.sort((a, b) => a.k0 - b.k0 || a.k1 - b.k1 || a.k2 - b.k2);
  return ranked.map((r) => r.node);
}

/** Whether the timeline carries any narration text (its final burst is the turn's
 *  answer — so the durable summary is suppressed to avoid double-rendering it). */
export function hasNarration(nodes: TimelineNode[]): boolean {
  return nodes.some((n) => n.kind === "text");
}
