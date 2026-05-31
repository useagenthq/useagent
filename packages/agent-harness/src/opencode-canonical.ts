/**
 * OpenCode -> Canonical translator (final_harness Phase 1).
 *
 * PURE + additive: maps the OpenCode native event stream (frames) AND the durable
 * step projection into the provider-neutral {@link CanonicalAgentEvent} vocabulary.
 * It changes nothing else - the existing native lane keeps flowing; this runs
 * ALONGSIDE it. Nothing downstream branches on provider names once this exists.
 *
 * TWO principles the tests enforce:
 *  1. LOSSLESS AT THE TRANSPORT BOUNDARY - child-session text/reasoning is preserved
 *     (emitted with its child/session identity + a child.started that names the
 *     session as a child); the translator NEVER decides what to hide. View reducers
 *     (buildTimelineFromCanonical) apply display policy.
 *  2. EXPLICIT SOURCE-EVENT ACCOUNTING - every source frame/step yields a recorded
 *     disposition (the canonical kinds it produced, or a NAMED suppression reason).
 *     There are no silent `continue` drops; the test asserts full accounting.
 */
import {
  ACP_COMMANDS_EVENT_TYPE,
  CANONICAL_SCHEMA_VERSION,
  SESSION_STARTED_EVENT_TYPE,
  parseAcpCommandsFrame,
  parseSessionStartedFrame,
  type CanonicalAgentEvent,
  type CanonicalChildState,
  type CanonicalEventBody,
  type CanonicalEventKind,
  type CanonicalPlanEntry,
} from "./canonical";
import {
  t3ActivityKind,
  t3Errored,
  t3Payload,
  t3Preview,
  t3ToolCallId,
  t3ToolDuration,
  t3ToolName,
  t3ToolServer,
  t3ToolStatus,
} from "./opencode-t3";
import type {
  Disposition,
  OpenCodeFrame,
  OpenCodeStep,
  TranslateCtx,
  TranslateResult,
} from "./opencode-types";
import {
  boundedPreview,
  canonicalChildState,
  firstString,
  recordValue as rec,
  stepFinishUsage,
  stringValue as str,
} from "./opencode-values";
import { markerFromSkynet } from "./skynet-context-marker";

export type {
  Disposition,
  OpenCodeFrame,
  OpenCodeStep,
  TranslateCtx,
  TranslateResult,
} from "./opencode-types";

const TASK_CHILD_ID = /<task\s+id="(ses_[^"]+)"/;
const TASK_RESULT = /<task_result>\s*([\s\S]*?)\s*<\/task_result>/;

/** The provider identity of a task-launched child: the task tool's own
 *  `state.metadata.sessionId`, else the `<task id="ses_*">` output marker, else
 *  the launching callId. Provider identifiers only - never display text. */
function taskChildId(
  state: Record<string, unknown> | null,
  callId: string | null,
): string | null {
  const metadata = rec(state?.metadata);
  return (
    firstString(metadata?.sessionId, metadata?.sessionID) ??
    TASK_CHILD_ID.exec(str(state?.output) ?? "")?.[1] ??
    callId
  );
}
const PLAN_STATUSES = new Set<CanonicalPlanEntry["status"]>([
  "pending",
  "in_progress",
  "completed",
  "cancelled",
]);

function planEntries(value: unknown): CanonicalPlanEntry[] | null {
  const input = rec(value);
  const todos = input?.todos;
  if (!Array.isArray(todos)) return null;

  const entries: CanonicalPlanEntry[] = [];
  for (const [index, value] of todos.entries()) {
    const todo = rec(value);
    const text = firstString(todo?.content, todo?.title, todo?.text)?.trim();
    if (!text) continue;
    const rawStatus = str(todo?.status);
    entries.push({
      id: firstString(todo?.id)?.trim() || `${index}-${text}`,
      text,
      status: rawStatus && PLAN_STATUSES.has(rawStatus as CanonicalPlanEntry["status"])
        ? rawStatus as CanonicalPlanEntry["status"]
        : "pending",
    });
  }
  return entries.length > 0 ? entries : null;
}

/**
 * Translate an OpenCode session (native frames + durable steps) into a canonical
 * event stream + full source-event accounting. Stateful over the stream; `seq` on
 * the output is Skynet's own dense monotonic cursor (the provider seq is preserved
 * in `identity.nativeSeq`).
 */
export function translateOpenCode(
  frames: readonly OpenCodeFrame[],
  ctx: TranslateCtx,
  steps: readonly OpenCodeStep[] = [],
): TranslateResult {
  const tsOf = ctx.ts ?? ((seq: number) => seq);
  const orderedFrames = frames.toSorted((a, b) => a.seq - b.seq);

  // Child sessions: any session linked to a parent (task fan-out). Established
  // LOSSLESSLY via child.started so reducers - not the translator - decide hiding.
  const childSessions = new Set<string>();
  const childParent = new Map<string, string>();
  for (const f of orderedFrames) {
    if (f.native.parentSessionId && f.native.sessionId) {
      childSessions.add(f.native.sessionId);
      childParent.set(f.native.sessionId, f.native.parentSessionId);
    }
  }

  // Resolve one stable child identity for every task call before translating
  // any lifecycle revision. OpenCode may reveal the real child session only on
  // completion; without this pre-scan the running frame uses callId while the
  // completion uses ses_*, splitting one child into two cards.
  const taskChildIdByCallId = new Map<string, string>();
  for (const f of orderedFrames) {
    const p = rec(f.payload);
    const callId = f.native.callId;
    if (!callId || !f.eventType.startsWith("part.tool") || p?.tool !== "task") continue;
    const resolved = taskChildId(rec(p.state), null);
    if (resolved) taskChildIdByCallId.set(callId, resolved);
    else if (!taskChildIdByCallId.has(callId)) taskChildIdByCallId.set(callId, callId);
  }

  // Pre-scanned REAL child metadata, keyed by provider child id: the child's own
  // session-lifecycle frame carries its title; the parent task-tool frames carry
  // the child's session id, agent role (`input.subagent_type`) and model
  // (`state.metadata.model.modelID`). Pre-scanning (like childSessions above)
  // lets establishment events carry this regardless of frame arrival order.
  // Fields the frames do not carry stay absent - nothing is fabricated.
  interface ChildSeed { title?: string; prompt?: string; role?: string; model?: string }
  const childSeed = new Map<string, ChildSeed>();
  const seedOf = (id: string): ChildSeed => {
    const existing = childSeed.get(id);
    if (existing) return existing;
    const created: ChildSeed = {};
    childSeed.set(id, created);
    return created;
  };
  for (const f of orderedFrames) {
    const p = rec(f.payload);
    const sid = f.native.sessionId;
    if (sid && childSessions.has(sid) && f.eventType.startsWith("session")) {
      const title = firstString(p?.title);
      if (title) seedOf(sid).title = title;
    }
    if (f.eventType.startsWith("part.tool") && p?.tool === "task") {
      const state = rec(p.state);
      const callId = f.native.callId;
      const childId = callId
        ? taskChildIdByCallId.get(callId) ?? taskChildId(state, callId)
        : taskChildId(state, null);
      if (!childId) continue;
      const seed = seedOf(childId);
      const title = firstString(p.title, state?.title);
      if (title && !seed.title) seed.title = title;
      const role = firstString(rec(state?.input)?.subagent_type);
      if (role) seed.role = role;
      const prompt = firstString(rec(state?.input)?.prompt);
      if (prompt) seed.prompt = prompt;
      const model = firstString(rec(rec(state?.metadata)?.model)?.modelID);
      if (model) seed.model = model;
    }
  }

  // Accumulated REAL child activity, updated as the stream is walked: latest
  // tool summary/name from the child's own tool parts, cumulative typed usage
  // summed from its part.step-finish frames (mirrors how the fleet ledger sums
  // the same counters).
  interface ChildActivity { summary?: string; lastToolName?: string; usage?: Record<string, number> }
  const childActivity = new Map<string, ChildActivity>();
  const activityOf = (id: string): ChildActivity => {
    const existing = childActivity.get(id);
    if (existing) return existing;
    const created: ChildActivity = {};
    childActivity.set(id, created);
    return created;
  };

  // Merged snapshot of everything REAL known about one child right now. `over`
  // carries frame-authoritative fields (e.g. the task tool's lifecycle status)
  // that win over accumulated values; usage is copied so later accumulation
  // never mutates an already-emitted event.
  const childStateOf = (
    childId: string,
    over: CanonicalChildState = {},
  ): CanonicalChildState | undefined => {
    const seed = childSeed.get(childId);
    const live = childActivity.get(childId);
    const merged: CanonicalChildState = {
      ...(live?.summary ? { summary: live.summary } : {}),
      ...(live?.lastToolName ? { lastToolName: live.lastToolName } : {}),
      ...(live?.usage ? { usage: { ...live.usage } } : {}),
      ...(seed?.prompt ? { prompt: seed.prompt } : {}),
      ...(seed?.role ? { role: seed.role } : {}),
      ...(seed?.model ? { model: seed.model } : {}),
      ...over,
    };
    return Object.keys(merged).length > 0 ? merged : undefined;
  };

  // Message-anchored ordering (mirrors buildTimeline): min seq per messageId (the
  // stable step-start anchor) + partId->messageId, so step tool events can be
  // emitted in the SAME order the legacy timeline places them.
  const msgOrderKey = new Map<string, number>();
  const partMessage = new Map<string, string>();
  for (const f of orderedFrames) {
    const mid = f.native.messageId;
    if (mid) {
      const prev = msgOrderKey.get(mid);
      if (prev === undefined || f.seq < prev) msgOrderKey.set(mid, f.seq);
      if (f.native.partId) partMessage.set(f.native.partId, mid);
    }
  }

  const emittedChild = new Set<string>();  // child sessionIds we've announced
  const seenTaskCall = new Set<string>();  // task-tool callIds we've opened
  const seenChild = new Set<string>();     // structured provider child ids we've opened
  const seenTool = new Set<string>();      // non-task tool callIds we've opened
  const seenT3Tool = new Set<string>();    // T3 tool callIds we've opened
  const authoritativeT3LifecycleIds = new Set<string>();
  const t3TaskToolUseIds = new Set<string>();
  const events: CanonicalAgentEvent[] = [];
  const accounting: Disposition[] = [];
  let cursor = 0;

  for (const f of orderedFrames) {
    if (!f.eventType.startsWith("t3.activity.")) continue;
    const activity = rec(f.payload);
    const activityKind = t3ActivityKind(f.eventType, activity);
    const payload = t3Payload(activity);
    if (activityKind.startsWith("task.")) {
      const taskId = firstString(payload?.taskId, f.native.callId);
      const toolUseId = firstString(payload?.toolUseId, payload?.toolCallId);
      if (taskId) authoritativeT3LifecycleIds.add(taskId);
      if (toolUseId) {
        t3TaskToolUseIds.add(toolUseId);
        authoritativeT3LifecycleIds.add(toolUseId);
      }
    } else if (activityKind.startsWith("tool.")) {
      authoritativeT3LifecycleIds.add(t3ToolCallId(f, activity, payload));
    }
  }

  const push = (id: string, provider: string, body: CanonicalEventBody, ident: Partial<CanonicalAgentEvent["identity"]> = {}, suffix = ""): CanonicalEventKind => {
    events.push({
      schemaVersion: CANONICAL_SCHEMA_VERSION,
      eventId: `${ctx.runId}:${id}${suffix}`,
      seq: cursor,
      runId: ctx.runId,
      threadId: ctx.threadId,
      ts: tsOf(cursor),
      identity: { provider, nativeEventId: id, ...ident },
      ...body,
    });
    cursor++;
    return body.kind;
  };

  // Announce a child session once (lossless: names the session a child so reducers
  // can route its parts; does not itself hide anything). Carries the pre-scanned
  // real metadata (title, agent role, model) when the frames provided it.
  const ensureChild = (produced: CanonicalEventKind[], f: OpenCodeFrame) => {
    const sid = f.native.sessionId;
    if (sid && childSessions.has(sid) && !emittedChild.has(sid)) {
      emittedChild.add(sid);
      const title = childSeed.get(sid)?.title;
      const state = childStateOf(sid);
      produced.push(push(`childsess:${sid}`, f.provider, {
        kind: "child.started",
        childId: sid,
        parentChildId: f.native.parentSessionId ?? childParent.get(sid),
        ...(title ? { title } : {}),
        ...(state ? { state } : {}),
      }, { nativeSessionId: sid }));
    }
  };

  // ── frame lane ──────────────────────────────────────────────────────────────
  for (const f of orderedFrames) {
    const p = rec(f.payload);
    const et = f.eventType;
    const produced: CanonicalEventKind[] = [];
    const ident = {
      nativeSessionId: f.native.sessionId ?? undefined,
      nativeSeq: f.seq,
      nativeMessageId: f.native.messageId ?? undefined,
      nativePartId: f.native.partId ?? undefined,
    };
    let suppressed: string | undefined;

    // Run-timing ledger frames (perf plan Phase 0) are developer diagnostics on
    // the durable lane - deliberately NOT timeline nodes. Suppressed BEFORE any
    // event emission (incl. child establishment) with a named reason so lossless
    // accounting still records them.
    if (et.startsWith("timing.")) {
      accounting.push({ sourceId: f.eventId, kind: et, provider: f.provider, produced: [], suppressed: "run-timing diagnostic (not a timeline node)" });
      continue;
    }

    ensureChild(produced, f); // lossless child-session establishment

    if (f.provider.startsWith("skynet")) {
      const marker = markerFromSkynet(et, p);
      if (marker) {
        // Carry the originating frame verbatim so the frontend reconstructs the FULL
        // typed TimelineMarker with the SAME parser the legacy native lane uses (H3):
        // no fabrication, deep-equal marker nodes.
        produced.push(push(f.eventId, f.provider, { kind: "context.marker", ...marker, sourceEventType: et, ...(p ? { sourcePayload: p } : {}) }, ident));
      }
      else if (et === "artifact.created" || et === "artifact.delivered") {
        const artifactId = str(p?.id);
        const name = str(p?.name);
        const sha256 = str(p?.sha256);
        const contentType = str(p?.content_type);
        const bytes = typeof p?.size_bytes === "number" ? p.size_bytes : null;
        if (artifactId && name && sha256 && contentType && bytes !== null) {
          const artifact = { artifactId, bytes, sha256, contentType };
          if (et === "artifact.created") {
            produced.push(push(f.eventId, f.provider, { kind: "artifact.created", artifact, name }, ident));
          } else {
            produced.push(push(f.eventId, f.provider, {
              kind: "artifact.delivered",
              artifact,
              name,
              destination: str(p?.destination) ?? "unknown",
            }, ident));
          }
        } else suppressed = `${et} without a complete artifact descriptor`;
      }
      else if (et === "secrets.injected") produced.push(push(f.eventId, f.provider, { kind: "session.metadata", metadata: { secretsInjected: true } }, ident));
      else produced.push(push(f.eventId, f.provider, { kind: "harness.warning", message: "unmapped skynet event", rawEventType: et, rawPayload: f.payload }, ident));
    } else if (et === "question.asked") {
      const questionId = str(p?.id);
      const rawQuestions = Array.isArray(p?.questions) ? p.questions : [];
      const questions = rawQuestions.flatMap((raw) => {
        const question = rec(raw);
        if (!question || typeof question.question !== "string") return [];
        const options = Array.isArray(question.options)
          ? question.options.flatMap((rawOption) => {
              const option = rec(rawOption);
              return option && typeof option.label === "string"
                ? [{
                    label: option.label,
                    ...(typeof option.description === "string"
                      ? { description: option.description }
                      : {}),
                  }]
                : [];
            })
          : [];
        return [{
          ...(typeof question.header === "string" ? { header: question.header } : {}),
          prompt: question.question,
          options,
          multiple: question.multiple === true,
          custom: question.custom !== false,
        }];
      });
      const first = questions[0];
      if (questionId && first && questions.length === rawQuestions.length) {
        produced.push(push(f.eventId, f.provider, {
          kind: "question.requested",
          questionId,
          prompt: first.prompt,
          options: first.options.map((option) => option.label),
          questions,
        }, ident));
      } else suppressed = "malformed question request";
    } else if (et === "question.replied" || et === "question.rejected") {
      const questionId = str(p?.requestID);
      const answers = Array.isArray(p?.answers)
        ? p.answers.flatMap((raw) =>
            Array.isArray(raw) && raw.every((answer) => typeof answer === "string")
              ? [raw as string[]]
              : [],
          )
        : [];
      if (questionId) {
        const rejected = et === "question.rejected";
        produced.push(push(f.eventId, f.provider, {
          kind: "question.resolved",
          questionId,
          answer: rejected ? "Rejected" : answers.flat().join(", "),
          answers,
          status: rejected ? "rejected" : "answered",
        }, ident));
      } else suppressed = "question resolution without requestID";
    } else if (et.startsWith("t3.activity.")) {
      const activity = p;
      const activityKind = t3ActivityKind(et, activity);
      const payload = t3Payload(activity);
      const preview = t3Preview(activity, payload);

      function emitChildActivity(
        childId: string,
        title: string | undefined,
        terminal: boolean,
        errored: boolean,
        state: CanonicalChildState | undefined,
      ): void {
        if (activityKind.endsWith(".started")) {
          seenChild.add(childId);
          produced.push(push(f.eventId, f.provider, {
            kind: "child.started",
            childId,
            title,
            ...(state ? { state } : {}),
          }, ident, "#child-start"));
        } else if (terminal) {
          produced.push(push(f.eventId, f.provider, {
            kind: "child.completed",
            childId,
            status: errored ? "error" : "ok",
            result: preview,
            ...(state ? { state } : {}),
          }, ident, "#child-done"));
        } else {
          produced.push(push(f.eventId, f.provider, {
            kind: "child.updated",
            childId,
            status: preview ?? firstString(payload?.status) ?? "running",
            ...(state ? { state } : {}),
          }, ident, "#child-upd"));
        }
      }

      function emitToolActivity(
        callId: string,
        name: string,
        title: string | undefined,
        terminal: boolean,
        errored: boolean,
      ): void {
        const server = t3ToolServer(payload, activity?.summary);
        const nativeStatus = t3ToolStatus(payload);
        const durationMs = t3ToolDuration(payload);
        const start = (): void => {
          seenT3Tool.add(callId);
          produced.push(push(f.eventId, f.provider, {
            kind: "tool.started",
            toolCallId: callId,
            name,
            title,
            ...(server ? { server } : {}),
            ...(nativeStatus ? { nativeStatus } : {}),
            ...(durationMs === undefined ? {} : { durationMs }),
          }, ident, "#tool-start"));
        };
        if (activityKind.endsWith(".started")) {
          start();
        } else if (terminal) {
          if (!seenT3Tool.has(callId)) start();
          produced.push(push(f.eventId, f.provider, {
            kind: "tool.completed",
            toolCallId: callId,
            status: errored ? "error" : "ok",
            ...(preview ? { preview } : {}),
            ...(errored && preview ? { error: preview } : {}),
            ...(nativeStatus ? { nativeStatus } : {}),
            ...(durationMs === undefined ? {} : { durationMs }),
          }, ident, "#tool-done"));
        } else {
          if (!seenT3Tool.has(callId)) start();
          produced.push(push(f.eventId, f.provider, {
            kind: "tool.progress",
            toolCallId: callId,
            ...(preview ? { preview } : {}),
            ...(nativeStatus ? { nativeStatus } : {}),
            ...(durationMs === undefined ? {} : { durationMs }),
          }, ident, "#tool-prog"));
        }
      }

      if (activityKind.startsWith("context-window.")) {
        suppressed = "t3 context-window diagnostic (not a timeline node)";
      } else if (activityKind.startsWith("task.")) {
        const nativeTaskId = firstString(payload?.taskId, f.native.callId);
        const isAgentTask = payload?.agentKind === "agent";
        const title = firstString(payload?.title, payload?.role, activity?.summary) ?? undefined;
        const errored = t3Errored(activityKind, activity, payload);
        const terminal = activityKind.endsWith(".completed") || activityKind.endsWith(".error") || activityKind.endsWith(".failed");
        const state = canonicalChildState(payload);

        if (isAgentTask && !nativeTaskId) {
          suppressed = "t3 agent task without provider child identity";
        } else if (isAgentTask && nativeTaskId) {
          emitChildActivity(nativeTaskId, title, terminal, errored, state);
        } else {
          const callId = nativeTaskId ?? firstString(activity?.id, f.eventId) ?? f.eventId;
          const name = title ?? "task";
          emitToolActivity(callId, name, title, terminal, errored);
        }
      } else if (activityKind.startsWith("tool.")) {
        const callId = t3ToolCallId(f, activity, payload);
        const itemType = str(payload?.itemType);
        const explicitChildId = firstString(payload?.childSessionId, payload?.taskId);
        if (itemType === "collab_agent_tool_call" && t3TaskToolUseIds.has(callId)) {
          suppressed = "duplicate t3 collaboration wrapper (task lifecycle is authoritative)";
        } else if (itemType === "collab_agent_tool_call" && explicitChildId) {
          // A collaboration wrapper is a child only when the transport provides
          // a real child session/task identity. Tool/activity ids identify the
          // wrapper call, not a child, and must never be promoted to child ids.
          const title = firstString(activity?.summary, payload?.summary, payload?.title) ?? undefined;
          const errored = t3Errored(activityKind, activity, payload);
          const terminal = activityKind.endsWith(".completed") ||
            activityKind.endsWith(".error") ||
            activityKind.endsWith(".failed") ||
            activityKind.endsWith(".denied");
          emitChildActivity(
            explicitChildId,
            title,
            terminal,
            errored,
            canonicalChildState(payload),
          );
        } else {
          const name = t3ToolName(payload, activity?.summary);
          const title = firstString(activity?.summary, payload?.summary) ?? undefined;
          const errored = t3Errored(activityKind, activity, payload);
          const terminal = activityKind.endsWith(".completed") || activityKind.endsWith(".error") || activityKind.endsWith(".failed") || activityKind.endsWith(".denied");

          emitToolActivity(callId, name, title, terminal, errored);
          const owningChildId = firstString(payload?.taskId);
          if (owningChildId && seenChild.has(owningChildId)) {
            const childSummary = preview ?? `Running ${name}`;
            produced.push(push(f.eventId, f.provider, {
              kind: "child.updated",
              childId: owningChildId,
              status: childSummary,
              state: canonicalChildState(payload, {
                summary: childSummary,
                lastToolName: name,
              }),
            }, ident, "#child-upd"));
          }
        }
      } else {
        produced.push(push(f.eventId, f.provider, { kind: "harness.warning", message: "unmapped t3 activity", rawEventType: et, rawPayload: f.payload }, ident));
      }
    } else if (et === SESSION_STARTED_EVENT_TYPE) {
      // A real provider session was established: emit the session-identified `session.started`
      // carrying the ONE capability map the UI gates every surface on (no provider-name guess).
      // MUST precede the generic `session*` -> session.metadata branch (session.started also
      // starts with "session").
      const parsed = parseSessionStartedFrame(p);
      if (parsed) {
        produced.push(push(f.eventId, f.provider, {
          kind: "session.started",
          capabilities: parsed.capabilities,
          source: parsed.source ?? f.provider,
        }, ident));
      } else suppressed = "session.started without a capabilities map";
    } else if (et.startsWith("session")) {
      produced.push(push(f.eventId, f.provider, { kind: "session.metadata", metadata: p ?? {} }, ident));
    } else if (et === "part.step-start") {
      // The message ANCHOR (lowest seq per message) - emitted losslessly so view
      // reducers can reproduce message-anchored ordering. Skipped only if it carries
      // no messageId (nothing to anchor).
      if (f.native.messageId) produced.push(push(f.eventId, f.provider, { kind: "message.started", messageId: f.native.messageId }, ident));
      else suppressed = "step-start without messageId";
    } else if (et === "part.step-finish") {
      const mid = f.native.messageId;
      if (mid) {
        produced.push(push(f.eventId, f.provider, { kind: "message.completed", messageId: mid }, ident));
        // A CHILD step-finish carries the step's real token/cost counters; sum
        // them into the child's cumulative usage and surface the new total via
        // child.updated (the message.completed above stays - reducers anchor
        // message lifecycle on it). An empty payload contributes nothing.
        const sid = f.native.sessionId;
        const usage = sid && childSessions.has(sid) ? stepFinishUsage(p) : undefined;
        if (sid && usage) {
          const live = activityOf(sid);
          live.usage = live.usage ?? {};
          for (const [key, value] of Object.entries(usage)) {
            live.usage[key] = (live.usage[key] ?? 0) + value;
          }
          const state = childStateOf(sid);
          produced.push(push(f.eventId, f.provider, {
            kind: "child.updated",
            childId: sid,
            status: live.summary ?? "running",
            ...(state ? { state } : {}),
          }, ident, "#child-upd"));
        }
      }
      else suppressed = "step-finish without messageId";
    } else if (et.startsWith("part.text")) {
      const mid = f.native.messageId;
      if (mid) produced.push(push(f.eventId, f.provider, { kind: "message.delta", messageId: mid, text: str(p?.text) ?? "" }, ident));
      else suppressed = "text part without messageId";
    } else if (et.startsWith("part.reasoning")) {
      const mid = f.native.messageId ?? f.native.partId ?? f.eventId;
      if (et.endsWith(".completed")) produced.push(push(f.eventId, f.provider, { kind: "reasoning.completed", messageId: mid }, ident));
      else produced.push(push(f.eventId, f.provider, { kind: "reasoning.delta", messageId: mid, text: str(p?.text) ?? "" }, ident));
    } else if (et.startsWith("part.tool") || et.startsWith("part.subtask")) {
      const callId = f.native.callId;
      const isTask = p?.tool === "task" || et.startsWith("part.subtask");
      const todoPlan = p?.tool === "todowrite"
        ? planEntries(rec(p?.state)?.input ?? p?.input)
        : null;
      const terminal = et.endsWith(".completed") || et.endsWith(".error");
      const errored = et.endsWith(".error");
      if (todoPlan) {
        produced.push(push(f.eventId, f.provider, {
          kind: "plan.updated",
          entries: todoPlan,
        }, ident));
      } else if (isTask && callId) {
        const state = rec(p?.state);
        const output = str(state?.output) ?? "";
        const childId = taskChildIdByCallId.get(callId) ?? callId;
        // Frame-authoritative lifecycle status (the task tool's own state) wins;
        // the merged snapshot adds the accumulated child-session activity plus
        // the pre-scanned role/model, so the lifecycle events carry REAL state.
        const childState = childStateOf(childId, canonicalChildState(state) ?? {});
        if (!seenTaskCall.has(callId)) {
          seenTaskCall.add(callId);
          produced.push(push(f.eventId, f.provider, {
            kind: "child.started",
            childId,
            launchToolCallId: callId,
            title: firstString(p?.title, state?.title, childSeed.get(childId)?.title) ?? undefined,
            ...(childState ? { state: childState } : {}),
          }, ident, "#child-start"));
        }
        if (terminal) {
          const result = TASK_RESULT.exec(output)?.[1]?.trim();
          produced.push(push(f.eventId, f.provider, {
            kind: "child.completed",
            childId,
            status: errored ? "error" : "ok",
            result: result || undefined,
            ...(childState ? { state: childState } : {}),
          }, ident, "#child-done"));
        } else {
          produced.push(push(f.eventId, f.provider, {
            kind: "child.updated",
            childId,
            status: "running",
            ...(childState ? { state: childState } : {}),
          }, ident, "#child-upd"));
        }
      } else if (callId && !seenTool.has(callId) && !terminal) {
        seenTool.add(callId);
        produced.push(push(f.eventId, f.provider, { kind: "tool.started", toolCallId: callId, name: str(p?.tool) ?? "tool" }, ident, "#tool-start"));
      } else if (terminal) {
        produced.push(push(f.eventId, f.provider, { kind: "tool.completed", toolCallId: callId ?? f.eventId, status: errored ? "error" : "ok" }, ident, "#tool-done"));
      } else {
        produced.push(push(f.eventId, f.provider, { kind: "tool.progress", toolCallId: callId ?? f.eventId }, ident, "#tool-prog"));
      }
      // Child ACTIVITY beat: a tool part owned by a child session updates that
      // child's accumulated summary/lastToolName (REAL payload fields only) and
      // emits child.updated so live cards move with the child's actual work.
      // Task parts are excluded above - their own child lifecycle is authoritative.
      const ownerSid = f.native.sessionId;
      if (ownerSid && childSessions.has(ownerSid) && !(isTask && callId)) {
        const live = activityOf(ownerSid);
        const st = rec(p?.state);
        const toolName = str(p?.tool);
        const preview = boundedPreview(st?.error, st?.title, st?.output);
        if (toolName) live.lastToolName = toolName;
        if (preview) live.summary = preview;
        const state = childStateOf(ownerSid);
        produced.push(push(f.eventId, f.provider, {
          kind: "child.updated",
          childId: ownerSid,
          status: live.summary ?? "running",
          ...(state ? { state } : {}),
        }, ident, "#child-upd"));
      }
    } else if (et === ACP_COMMANDS_EVENT_TYPE) {
      // An ACP session's native command-catalog REPLACEMENT, captured durably into the
      // provider-events lane. Emit it as a session-identified `commands.updated` (the
      // `ident.nativeSessionId` set below carries the native session, so the client can
      // scope the catalog to the CURRENT session). An EMPTY catalog is a genuine empty
      // replacement, not a drop. One frame per session (upserted at capture), so the
      // stable eventId keeps re-canonicalization idempotent (latest revision wins).
      const parsed = parseAcpCommandsFrame(p);
      if (parsed) {
        produced.push(push(f.eventId, f.provider, {
          kind: "commands.updated",
          commands: parsed.catalog.map((c) => c.name),
          catalog: parsed.catalog,
          source: parsed.source ?? f.provider,
          ...(parsed.generation != null ? { generation: parsed.generation } : {}),
        }, ident));
      } else suppressed = "acp.commands without a parseable catalog";
    } else {
      produced.push(push(f.eventId, f.provider, { kind: "harness.warning", message: "unmapped opencode event", rawEventType: et, rawPayload: f.payload }, ident));
    }

    accounting.push({ sourceId: f.eventId, kind: et, provider: f.provider, produced, ...(produced.length === 0 ? { suppressed } : {}) });
  }

  // ── step lane ────────────────────────────────────────────────────────────────
  // Tool ROWS in the legacy timeline come from the durable step projection, not the
  // frames. Emit a canonical tool.completed per non-`done` step (LOSSLESS: incl.
  // narration/boot pseudo-steps - the reducer applies display policy), ordered by the
  // SAME message-anchored key buildTimeline uses so the canonical seq preserves the
  // legacy timeline order. `done` steps are terminal markers (not timeline nodes) and
  // are explicitly accounted, not silently dropped.
  const MAX = Number.MAX_SAFE_INTEGER;
  // Steps carry no provider of their own; attribute them to the run's engine (honest
  // provenance for claude/codex ACP tool rows, not a hardcoded "opencode").
  const stepProvider = ctx.engine ?? "opencode";
  const stepKey = (s: OpenCodeStep): [number, number] => {
    let partID: string | null = null, messageID: string | null = null;
    if (s.code_json) {
      try {
        const n = rec(JSON.parse(s.code_json))?.native as Record<string, unknown> | undefined;
        partID = str(n?.partID); messageID = str(n?.messageID);
      } catch { /* keep nulls */ }
    }
    const mid = (partID && partMessage.get(partID)) || messageID || null;
    const k0 = mid ? msgOrderKey.get(mid) ?? MAX : MAX;
    return [k0, s.idx];
  };
  const orderedSteps = steps
    .map((s, i) => ({ s, i, k: stepKey(s) }))
    .toSorted((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1] || a.i - b.i);

  for (const { s } of orderedSteps) {
    if (s.kind === "done") {
      accounting.push({ sourceId: s.id, kind: `step:${s.kind}`, provider: stepProvider, produced: [], suppressed: "terminal done step (not a timeline node)" });
      continue;
    }
    let callID: string | null = null, errored = false, native: Record<string, unknown> | undefined, code: Record<string, unknown> | null = null;
    if (s.code_json) {
      try {
        code = rec(JSON.parse(s.code_json));
        native = rec(code?.native) ?? undefined;
        callID = str(native?.callID);
        errored = code?.error === true;
      } catch { /* keep defaults */ }
    }
    const ident = {
      nativeEventId: s.id, // step id = the reducer's node key + lookup handle
      nativeSessionId: str(native?.sessionID) ?? undefined,
    };
    if (code?.source === "t3" && callID && authoritativeT3LifecycleIds.has(callID)) {
      accounting.push({
        sourceId: s.id,
        kind: `step:${s.kind}`,
        provider: stepProvider,
        produced: [],
        suppressed: "t3 provider activity lifecycle is authoritative",
      });
      continue;
    }
    const todoPlan = str(code?.tool)?.toLowerCase() === "todowrite"
      ? planEntries(rec(code?.input))
      : null;
    if (todoPlan) {
      const produced = [push(`step:${s.id}`, stepProvider, {
        kind: "plan.updated",
        entries: todoPlan,
      }, ident)];
      accounting.push({ sourceId: s.id, kind: `step:${s.kind}`, provider: stepProvider, produced });
      continue;
    }
    // Every non-done step is a tool ROW in the legacy timeline (command + file
    // alike), so it maps to tool.completed for node-equivalence. (A separate
    // file.changed for the editor pane is a later, additive refinement.)
    const toolCallId = callID ?? s.id;
    const stepToolName = code?.source === "t3" ? firstString(code?.tool, code?.name, s.chip, s.kind) : null;
    const stepPreview = code?.source === "t3"
      ? boundedPreview(code?.output, code?.summary, code?.error, s.label)
      : undefined;
    const produced: CanonicalEventKind[] = [];
    if (stepToolName) {
      const startBody: CanonicalEventBody = {
        kind: "tool.started",
        toolCallId,
        name: stepToolName,
        ...(s.label ? { title: s.label } : {}),
      };
      produced.push(push(`step:${s.id}`, stepProvider, startBody, ident, "#tool-start"));
    }
    const body: CanonicalEventBody = {
      kind: "tool.completed",
      toolCallId,
      status: errored ? "error" : "ok",
      ...(stepPreview ? { preview: stepPreview } : {}),
      ...(errored && stepPreview ? { error: stepPreview } : {}),
    };
    produced.push(push(`step:${s.id}`, stepProvider, body, ident));
    accounting.push({ sourceId: s.id, kind: `step:${s.kind}`, provider: stepProvider, produced });
  }

  return { events, accounting };
}
