// Protocol 2 fixtures built from the runtime contract (upstream ce90eec1f,
// packages/contracts/src/orchestrationV2.ts) and checked on 2026-10-03 against
// frames recorded from runtime dd2b1389590f with Codex and OpenCode 2: every
// field the driver reads matches. Claude, file changes, plans, errors and
// compaction were not yet seen live.
import { describe, expect, test } from "bun:test";
import type { PermissionMode } from "@useagent/agent-client/wire";
import { json } from "./helpers";
import { recordProviderEvent, threadHasSessionGrant } from "../src/runs/provider-events";
import { waitForRuntimeTurn } from "../src/engines/runtime-adapter";
import { replyToRuntimeApproval, type RuntimeApprovalReplyDependencies } from "../src/engines/runtime-approval";
import { assertReadOnlyTurnAllowed } from "../src/engines/runtime-thread-mode";
import { runtimeThreadId } from "../src/engines/runtime-orchestration";
import type { FollowRuntimeThreadInput } from "../src/engines/runtime-event-stream";
import { runtimeThreadView } from "../src/engines/runtime-v2-view";
import type { V2ThreadSnapshot } from "../src/engines/runtime-v2-wire";
import type { EmitStep, EngineRunContext } from "../src/engines/types";
import type { SandboxHandle } from "../src/sandboxes/provider";
import { createSecretRedactor } from "../src/secrets/redact";
import { SANDBOX_NAME_PREFIX } from "../src/sandboxes/sandbox-names";

// Enforcement per permission mode at the runtime adapter boundary, against a
// real accepted run so the projector's provider-event record lands. The
// runtime's own approval requests arrive in the thread's state; a read-only run
// must decline every command and file change itself, a Guard run must leave
// them waiting for a person, and reads pass in both.

async function acceptedRun(permissionMode: PermissionMode) {
  const { status, body } = await json<{ id: string }>("/api/runs", {
    method: "POST",
    body: { prompt: "look around", permission_mode: permissionMode },
  });
  expect(status).toBe(201);
  const { body: run } = await json<{ thread_id: string; permission_mode: string }>(`/api/runs/${body.id}`);
  expect(run.permission_mode).toBe(permissionMode);
  return { runId: body.id, threadId: run.thread_id };
}

/** The thread with the plane's run `runId` in `status` and one approval request in `requestStatus`. */
function thread(
  ctx: Pick<EngineRunContext, "runId" | "threadId">,
  sequence: number,
  runId: string,
  status: "running" | "completed",
  request: { readonly kind: string; readonly status: "pending" | "resolved" } | null,
): V2ThreadSnapshot {
  const threadId = runtimeThreadId(ctx);
  return {
    snapshotSequence: sequence,
    projection: {
      thread: { id: threadId, runtimeMode: "approval-required", activeProviderThreadId: null },
      runs: [{ id: runId, ordinal: runId === "turn-prior" ? 1 : 2, userMessageId: `${SANDBOX_NAME_PREFIX}-message-${runId}`, status, providerThreadId: null, requestedAt: "2026-10-03T00:00:00.000Z", startedAt: null, completedAt: null }],
      messages: [{ id: "assistant-1", runId, role: "assistant", text: "Looked around.", streaming: status === "running", createdAt: "2026-10-03T00:00:01.000Z" }],
      turnItems: request
        ? [{ id: "item-approval-1", threadId, runId, type: "approval_request", status: request.status === "pending" ? "waiting" : "completed", title: null, updatedAt: "x", ordinal: 1, requestId: "approval-1", requestKind: request.kind, prompt: "rm -rf build" }]
        : [],
      providerSessions: [],
      providerThreads: [],
      runtimeRequests: request ? [{ id: "approval-1", kind: request.kind, status: request.status, ...(request.status === "resolved" ? { decision: "decline" } : {}) }] : [],
      subagents: [],
    },
  };
}

async function driveTurn(permissionMode: PermissionMode, requestKind: string) {
  const run = await acceptedRun(permissionMode);
  const steps: EmitStep[] = [];
  const replies: unknown[] = [];
  const ctx = {
    runId: run.runId,
    threadId: run.threadId,
    permissionMode,
    signal: new AbortController().signal,
    emit: async (step: EmitStep) => {
      steps.push(step);
      return undefined;
    },
    setSummary() {},
    publishDelta() {},
  } as unknown as EngineRunContext;
  const prior = runtimeThreadView(thread(ctx, 10, "turn-prior", "completed", null));
  const follow = async (input: FollowRuntimeThreadInput) => {
    for (const state of [
      thread(ctx, 11, "turn-1", "running", { kind: requestKind, status: "pending" }),
      thread(ctx, 12, "turn-1", "completed", { kind: requestKind, status: "resolved" }),
    ]) {
      if (!(await input.applySnapshot(runtimeThreadView(state), state))) return;
    }
  };
  const text = await waitForRuntimeTurn(
    ctx,
    {} as SandboxHandle,
    new Map(),
    prior,
    createSecretRedactor([]),
    {
      followRuntimeThread: follow,
      readThreadSnapshot: async () => {
        throw new Error("unexpected HTTP thread read");
      },
      replyToRuntimeApproval: async (input) => {
        replies.push(input);
        return { alreadyAnswered: false };
      },
      guardForeignRuns: () => async () => [],
    },
  );
  return { ctx, text, steps, replies };
}

describe("permission mode enforcement in the runtime adapter", () => {
  test("a read-only run declines a file change through the reply path and records the refusal", async () => {
    const { ctx, text, steps, replies } = await driveTurn("read-only", "file-change");
    expect(text).toBe("Looked around.");
    expect(replies).toEqual([{
      runId: ctx.runId,
      threadId: ctx.threadId,
      sessionId: runtimeThreadId(ctx),
      requestId: "approval-1",
      decision: "decline",
      signal: ctx.signal,
      expectedSandbox: null,
      permissionMode: "read-only",
    }]);
    expect(steps.some((step) => step.label === "Refused to change files: this run is read-only" && step.chip === "read-only")).toBe(true);
  });

  test("a read-only run declines a command too, and only once per request", async () => {
    const { replies, steps } = await driveTurn("read-only", "command");
    expect(replies).toHaveLength(1);
    expect(steps.filter((step) => step.chip === "read-only").map((step) => step.label)).toEqual([
      "Refused to run a command: this run is read-only",
    ]);
  });

  test("a read-only run lets a file read wait for the person instead of refusing it", async () => {
    const { replies, steps } = await driveTurn("read-only", "file-read");
    expect(replies).toEqual([]);
    expect(steps.some((step) => step.chip === "read-only")).toBe(false);
  });

  test("a Guard run leaves an edit waiting for the person; nothing is answered on its behalf", async () => {
    const { replies, steps } = await driveTurn("approval-required", "file-change");
    expect(replies).toEqual([]);
    expect(steps.some((step) => step.chip === "read-only")).toBe(false);
  });

  /** The reply path against a fake runtime holding one pending command request,
   *  with the ledger writes routed through `recordEvent`. */
  function grantHarness(run: { runId: string; threadId: string }, options: { readonly loseReceipt: boolean }) {
    const sessionId = runtimeThreadId({ runId: run.runId, threadId: run.threadId });
    const log: string[] = [];
    const dependencies: Partial<RuntimeApprovalReplyDependencies> = {
      resolveSandbox: async () => ({} as SandboxHandle),
      request: (async () => thread(run, 3, "turn-1", "running", { kind: "command", status: "pending" })) as unknown as RuntimeApprovalReplyDependencies["request"],
      dispatch: async (_sandbox, command) => {
        log.push(`dispatch:${String(command.decision)}`);
        return { sequence: 4 };
      },
      recordEvent: (async (input, opts) => {
        if (options.loseReceipt && input.eventType === "approval.responded") throw new Error("ledger unavailable");
        log.push(`record:${input.eventType}`);
        return recordProviderEvent(input, opts);
      }) as RuntimeApprovalReplyDependencies["recordEvent"],
    };
    const reply = (decision: "accept" | "acceptForSession") => replyToRuntimeApproval({
      runId: run.runId,
      threadId: run.threadId,
      sessionId,
      requestId: "approval-1",
      decision,
      signal: new AbortController().signal,
      expectedSandbox: null,
      permissionMode: "approval-required",
    }, dependencies);
    return { log, reply };
  }

  test("a session grant is durable before the runtime sees it, so a lost receipt still keeps read only off that thread", async () => {
    const run = await acceptedRun("approval-required");
    expect(await threadHasSessionGrant(run.threadId)).toBe(false);
    const { log, reply } = grantHarness(run, { loseReceipt: true });
    await expect(reply("acceptForSession")).rejects.toThrow("ledger unavailable");
    // The intent landed before the grant was dispatched; the receipt never did.
    expect(log).toEqual(["record:approval.responding", "dispatch:acceptForSession"]);
    expect(await threadHasSessionGrant(run.threadId)).toBe(true);
    await expect(assertReadOnlyTurnAllowed({ threadId: run.threadId, permissionMode: "read-only", threadExists: true }))
      .rejects.toThrow("remembers approvals");
    // Other modes, and a thread the runtime has not created yet, are not held back by it.
    await assertReadOnlyTurnAllowed({ threadId: run.threadId, permissionMode: "approval-required", threadExists: true });
    await assertReadOnlyTurnAllowed({ threadId: run.threadId, permissionMode: "read-only", threadExists: false });
  });

  test("a confirmed session grant keeps read only off the thread; a plain accept does not", async () => {
    const granted = await acceptedRun("approval-required");
    const grant = grantHarness(granted, { loseReceipt: false });
    await expect(grant.reply("acceptForSession")).resolves.toEqual({ alreadyAnswered: false });
    expect(grant.log).toEqual(["record:approval.responding", "dispatch:acceptForSession", "record:approval.responded"]);
    await expect(assertReadOnlyTurnAllowed({ threadId: granted.threadId, permissionMode: "read-only", threadExists: true }))
      .rejects.toThrow("remembers approvals");

    const plain = await acceptedRun("approval-required");
    const once = grantHarness(plain, { loseReceipt: false });
    await expect(once.reply("accept")).resolves.toEqual({ alreadyAnswered: false });
    expect(once.log).toEqual(["dispatch:accept", "record:approval.responded"]);
    expect(await threadHasSessionGrant(plain.threadId)).toBe(false);
    await assertReadOnlyTurnAllowed({ threadId: plain.threadId, permissionMode: "read-only", threadExists: true });
  });
});
