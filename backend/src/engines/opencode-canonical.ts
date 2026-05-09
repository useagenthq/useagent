/**
 * OpenCode -> Canonical translator (final_harness Phase 1, slice 1).
 *
 * PURE + additive: maps the OpenCode native-event stream (the same frame shape the
 * backend already emits and the frontend golden fixture pins) into the provider-
 * neutral {@link CanonicalAgentEvent} vocabulary. It changes nothing else - the
 * existing native lane keeps flowing; this runs ALONGSIDE it. Nothing branches on
 * provider names downstream once this exists; that is the whole point.
 *
 * Slice-1 scope = the FRAME lane (text, reasoning, tool lifecycle, subagent/task
 * children, skynet context markers, session metadata). Tool payload DETAIL (name,
 * diff, output) lives on the steps lane and is folded in by slice 2 together with
 * the canonical->timeline deriver + exact golden equivalence. Every source event
 * maps to a canonical event or an explicit harness.warning - nothing is silently
 * dropped (asserted by the test).
 */
import {
  CANONICAL_SCHEMA_VERSION,
  type CanonicalAgentEvent,
  type CanonicalEventBody,
  type ContextMarkerKind,
} from "./canonical";

/** The OpenCode native frame this translator consumes (subset of the wire frame;
 *  matches backend src/runs/native-events.ts + the frontend NativeFrame). */
export interface OpenCodeFrame {
  eventId: string;
  seq: number;
  provider: string;
  eventType: string;
  native: {
    sessionId: string | null;
    parentSessionId: string | null;
    messageId: string | null;
    partId: string | null;
    callId: string | null;
  };
  payload: unknown;
}

export interface TranslateCtx {
  runId: string;
  threadId: string;
  /** ts source (Skynet-assigned, never trusted from the provider). Defaults to the
   *  frame seq for deterministic tests; the emit layer passes a real clock. */
  ts?: (frame: OpenCodeFrame) => number;
}

const rec = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

const TASK_CHILD_ID = /<task\s+id="(ses_[^"]+)"/;
const TASK_RESULT = /<task_result>\s*([\s\S]*?)\s*<\/task_result>/;

function markerFromSkynet(eventType: string, p: Record<string, unknown> | null):
  | { markerType: ContextMarkerKind; title: string; detail?: string }
  | null {
  if (eventType === "skill.loaded") {
    const playbook = p?.kind === "playbook";
    return {
      markerType: playbook ? "playbook" : "skill",
      title: str(p?.name) ?? (playbook ? "playbook" : "skill"),
      detail: typeof p?.version === "number" ? `v${p.version}` : undefined,
    };
  }
  if (eventType === "context.retrieved" || eventType === "knowledge.retrieved" || eventType === "memory.searched") {
    const src = str(p?.source) ?? (eventType === "knowledge.retrieved" ? "knowledge" : "memory");
    const n = typeof p?.itemCount === "number" ? p.itemCount : 0;
    return { markerType: src === "knowledge" ? "knowledge" : "memory", title: `Recalled ${n} item${n === 1 ? "" : "s"} from ${src}` };
  }
  if (eventType === "memory.l0_accepted" || eventType === "memory.updated" || eventType === "memory.deleted" || eventType === "memory.failed") {
    const failed = eventType === "memory.failed";
    const op = str(p?.op) ?? (eventType === "memory.updated" ? "correct" : eventType === "memory.deleted" ? "forget" : "remember");
    return { markerType: "memory", title: failed ? `Memory ${op} failed` : `Memory ${op}` };
  }
  return null;
}

/**
 * Translate an ordered OpenCode frame stream into canonical events. Stateful over
 * the stream (tracks assistant-step messages, seen tool calls, child sessions) so
 * the canonical output is lifecycle-correct. `seq` on the output is Skynet's own
 * dense monotonic cursor (independent of the provider's seq, which is preserved in
 * `identity.nativeSeq`).
 */
export function translateOpenCode(frames: readonly OpenCodeFrame[], ctx: TranslateCtx): CanonicalAgentEvent[] {
  const tsOf = ctx.ts ?? ((f: OpenCodeFrame) => f.seq);
  const ordered = [...frames].sort((a, b) => a.seq - b.seq);

  // A session is a CHILD if any frame links it to a parent (task fan-out).
  const childSessions = new Set<string>();
  for (const f of ordered) {
    if (f.native.parentSessionId && f.native.sessionId) childSessions.add(f.native.sessionId);
  }

  const seenTool = new Set<string>();   // callIds we've opened a tool.started for
  const seenChild = new Set<string>();  // callIds we've opened a child.started for
  const emittedText = new Set<string>(); // messageIds we emitted a message.delta for

  const out: CanonicalAgentEvent[] = [];
  let cursor = 0;
  const emit = (frame: OpenCodeFrame, body: CanonicalEventBody, suffix = ""): void => {
    out.push({
      schemaVersion: CANONICAL_SCHEMA_VERSION,
      eventId: `${ctx.runId}:${frame.eventId}${suffix}`,
      seq: cursor++,
      runId: ctx.runId,
      threadId: ctx.threadId,
      ts: tsOf(frame),
      identity: {
        provider: frame.provider,
        nativeSessionId: frame.native.sessionId ?? undefined,
        nativeEventId: frame.eventId,
        nativeSeq: frame.seq,
      },
      ...body,
    });
  };

  for (const f of ordered) {
    const p = rec(f.payload);
    const et = f.eventType;

    // ── skynet context lane (provider skynet*) ────────────────────────────────
    if (f.provider.startsWith("skynet")) {
      const marker = markerFromSkynet(et, p);
      if (marker) { emit(f, { kind: "context.marker", ...marker }); continue; }
      if (et === "secrets.injected") { emit(f, { kind: "session.metadata", metadata: { secretsInjected: true } }); continue; }
      if (et === "run.reconciling") { emit(f, { kind: "harness.warning", message: "Reconciling after a restart", rawEventType: et }); continue; }
      emit(f, { kind: "harness.warning", message: "unmapped skynet event", rawEventType: et });
      continue;
    }

    // ── session lifecycle ─────────────────────────────────────────────────────
    if (et.startsWith("session")) { emit(f, { kind: "session.metadata", metadata: p ?? {} }); continue; }

    // ── assistant message boundaries ──────────────────────────────────────────
    if (et === "part.step-start") {
      // No canonical event; marks the message as an assistant step for text routing.
      continue;
    }
    if (et === "part.step-finish") {
      const mid = f.native.messageId;
      if (mid && emittedText.has(mid)) emit(f, { kind: "message.completed", messageId: mid });
      continue;
    }

    // ── text / reasoning ──────────────────────────────────────────────────────
    if (et.startsWith("part.text")) {
      const sid = f.native.sessionId;
      const mid = f.native.messageId;
      if (sid && childSessions.has(sid)) continue; // subagent chatter -> its own child lane
      if (!mid) continue;
      emittedText.add(mid);
      emit(f, { kind: "message.delta", messageId: mid, text: str(p?.text) ?? "" });
      continue;
    }
    if (et.startsWith("part.reasoning")) {
      const mid = f.native.messageId ?? f.native.partId ?? f.eventId;
      if (et.endsWith(".completed")) emit(f, { kind: "reasoning.completed", messageId: mid });
      else emit(f, { kind: "reasoning.delta", messageId: mid, text: str(p?.text) ?? "" });
      continue;
    }

    // ── tools (incl. task-tool subagent fan-out) ─────────────────────────────
    if (et.startsWith("part.tool") || et.startsWith("part.subtask")) {
      const callId = f.native.callId;
      const isTask = p?.tool === "task" || et.startsWith("part.subtask");
      const terminal = et.endsWith(".completed") || et.endsWith(".error");
      const errored = et.endsWith(".error");

      if (isTask && callId) {
        const state = rec(p?.state);
        const output = str(state?.output) ?? "";
        const childId = TASK_CHILD_ID.exec(output)?.[1] ?? callId;
        if (!seenChild.has(callId)) {
          seenChild.add(callId);
          emit(f, { kind: "child.started", childId, launchToolCallId: callId, title: str(p?.title) ?? undefined }, "#child-start");
        }
        if (terminal) {
          const result = TASK_RESULT.exec(output)?.[1]?.trim();
          emit(f, { kind: "child.completed", childId, status: errored ? "error" : "ok", result: result || undefined }, "#child-done");
        } else {
          emit(f, { kind: "child.updated", childId, status: "running" }, "#child-upd");
        }
        continue;
      }

      if (callId && !seenTool.has(callId) && !terminal) {
        seenTool.add(callId);
        emit(f, { kind: "tool.started", toolCallId: callId, name: str(p?.tool) ?? "tool" }, "#tool-start");
        continue;
      }
      if (terminal) {
        emit(f, {
          kind: "tool.completed",
          toolCallId: callId ?? f.eventId,
          status: errored ? "error" : "ok",
        }, "#tool-done");
      } else {
        emit(f, { kind: "tool.progress", toolCallId: callId ?? f.eventId }, "#tool-prog");
      }
      continue;
    }

    // ── anything else: surfaced, never silently dropped ───────────────────────
    emit(f, { kind: "harness.warning", message: "unmapped opencode event", rawEventType: et });
  }

  return out;
}
