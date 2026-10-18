// Protocol 2 fixtures built from the runtime contract (upstream ce90eec1f,
// packages/contracts/src/orchestrationV2.ts) and checked on 2026-10-03 against
// frames recorded from runtime dd2b1389590f with Codex and OpenCode 2: every
// field the driver reads matches. Claude, file changes, plans, errors and
// compaction were not yet seen live.
import { expect, test } from "bun:test";
import { createSecretRedactor } from "../secrets/redact";
import type { ProviderEventInput } from "../runs/provider-events";
import type { SandboxHandle } from "../sandboxes/provider";
import {
  waitForRuntimeCompact,
} from "./runtime-compact-completion";
import {
  COMPACT_STOPPED_WAITING_SUMMARY,
  COMPACT_TIMED_OUT_WAITING_SUMMARY,
  RUNTIME_COMPACT_TIMEOUT_MS,
  compactRecoveryDeadlineMs,
  compactWaitTimeoutSummary,
} from "./runtime-compact-contract";
import type { FollowRuntimeThreadInput } from "./runtime-event-stream";
import { buildRuntimeTurnStartCommand, runtimeUserMessageId } from "./runtime-orchestration";
import { runtimeThreadView } from "./runtime-v2-view";
import type { V2RunStatus, V2ThreadSnapshot, V2TurnItem } from "./runtime-v2-wire";
import { v2Item, v2Projection, v2Run, v2Snapshot } from "./runtime-v2.test-support";
import type { EngineRunContext } from "./types";
import { SANDBOX_NAME_PREFIX } from "../sandboxes/sandbox-names";

const RUN_ID = "run-compact";
const THREAD_ID = `${SANDBOX_NAME_PREFIX}-thread-thread-1`;
const REQUEST_ID = runtimeUserMessageId(RUN_ID);

const prior = v2Run({ id: "prior", ordinal: 1 });
const compactRun = (status: V2RunStatus, userMessageId = REQUEST_ID) =>
  v2Run({ id: "compact", ordinal: 2, status, userMessageId, completedAt: status === "running" ? null : "x" });
const compaction = (status: string, runId = "compact") =>
  v2Item({ id: `compaction-${runId}`, type: "compaction", runId, status });

function state(sequence: number, runs = [prior], turnItems: V2TurnItem[] = []): V2ThreadSnapshot {
  return v2Snapshot(sequence, v2Projection({ runs, turnItems }));
}

const baseline = runtimeThreadView(state(1));

function context(signal = new AbortController().signal): EngineRunContext {
  return {
    runId: RUN_ID,
    threadId: "thread-1",
    signal,
    emit: async () => undefined,
    setSummary() {},
  } as unknown as EngineRunContext;
}

/** A follower whose script hands states over and checks whether the wait kept following. */
function dependencies(input: {
  script: (apply: (state: V2ThreadSnapshot) => Promise<boolean>, follow: FollowRuntimeThreadInput) => Promise<void>;
  captured?: ProviderEventInput[];
}) {
  return {
    followRuntimeThread: async (follow: FollowRuntimeThreadInput) => {
      await follow.start?.();
      await input.script((next) => follow.applySnapshot(runtimeThreadView(next), next), follow);
    },
    recordProviderEvent: async (event: ProviderEventInput) => {
      input.captured?.push(event);
    },
  };
}

test("compact dispatch and completion use the same accepted message identity", () => {
  const command = buildRuntimeTurnStartCommand({ runId: RUN_ID, threadId: "thread-1" }, "codex", "/compact");
  expect(command).toMatchObject({ type: "message.dispatch", messageId: REQUEST_ID, text: "/compact" });
});

test("Stop and timeout say only that UseAgent stopped waiting", () => {
  expect(RUNTIME_COMPACT_TIMEOUT_MS).toBe(600_000);
  expect(COMPACT_STOPPED_WAITING_SUMMARY).toStartWith("Stopped by user.");
  expect(COMPACT_STOPPED_WAITING_SUMMARY).toContain("may still finish");
  expect(compactWaitTimeoutSummary("compact", true, new Error("timeout")))
    .toBe(COMPACT_TIMED_OUT_WAITING_SUMMARY);
  expect(compactWaitTimeoutSummary(
    "compact",
    false,
    new Error(COMPACT_TIMED_OUT_WAITING_SUMMARY),
  )).toBe(COMPACT_TIMED_OUT_WAITING_SUMMARY);
  expect(compactWaitTimeoutSummary("review", true, new Error("timeout"))).toBeNull();
});

test("restart recovery preserves the original compact deadline", () => {
  const now = Date.UTC(2026, 8, 14, 12);
  expect(compactRecoveryDeadlineMs(now - 9 * 60_000)).toBe(now + 60_000);
  expect(compactRecoveryDeadlineMs(now - 11 * 60_000)).toBeLessThan(now);
  // Provisioning may predate the accepted native operation by many minutes.
  expect(compactRecoveryDeadlineMs(now - 20 * 60_000, now - 9 * 60_000)).toBe(now + 60_000);
});

test("compact completes from its own compaction while an unrelated one does not count", async () => {
  const captured: ProviderEventInput[] = [];
  let started = 0;
  await expect(waitForRuntimeCompact(
    context(),
    {} as SandboxHandle,
    baseline,
    createSecretRedactor([]),
    REQUEST_ID,
    dependencies({
      captured,
      script: async (apply) => {
        const other = v2Run({ id: "other", ordinal: 2, userMessageId: `${SANDBOX_NAME_PREFIX}-message-other` });
        expect(await apply(state(2, [prior, other], [compaction("completed", "other")]))).toBe(true);
        expect(await apply(state(3, [prior, other, { ...compactRun("running"), ordinal: 3 }], [compaction("completed", "other"), compaction("completed")])))
          .toBe(false);
      },
    }),
    async () => { started += 1; },
  )).resolves.toBe("Compacted");
  expect(started).toBe(1);
  expect(captured).toHaveLength(1);
  expect(captured[0]).toMatchObject({ eventType: "t3.activity.context-compaction", nativeSessionId: THREAD_ID });
});

test("a compact run that ends without its compaction still settles the wait", async () => {
  await expect(waitForRuntimeCompact(
    context(), {} as SandboxHandle, baseline, createSecretRedactor([]), REQUEST_ID,
    dependencies({
      script: async (apply) => {
        expect(await apply(state(2, [prior, compactRun("running")]))).toBe(true);
        expect(await apply(state(3, [prior, compactRun("completed")]))).toBe(false);
      },
    }),
  )).resolves.toBe("Compacted");
});

test("a follow that ends before the compact settles is an error", async () => {
  await expect(waitForRuntimeCompact(
    context(), {} as SandboxHandle, baseline, createSecretRedactor([]), REQUEST_ID,
    dependencies({ script: async (apply) => { expect(await apply(state(2, [prior, compactRun("running")]))).toBe(true); } }),
  )).rejects.toThrow("subscription ended before compact completed");
});

test("compact cancellation preserves the caller's abort reason", async () => {
  const controller = new AbortController();
  const reason = new Error("compact cancelled");
  const waiting = waitForRuntimeCompact(
    context(controller.signal), {} as SandboxHandle, baseline, createSecretRedactor([]), REQUEST_ID,
    dependencies({
      script: async (_apply, follow) => {
        if (!follow.signal.aborted) {
          await new Promise<void>((resolve) => follow.signal.addEventListener("abort", () => resolve(), { once: true }));
        }
      },
    }),
  );
  controller.abort(reason);
  await expect(waiting).rejects.toBe(reason);
});

test("a failed compact run stays a failure with the runtime's reason", async () => {
  await expect(waitForRuntimeCompact(
    context(), {} as SandboxHandle, baseline, createSecretRedactor([]), REQUEST_ID,
    dependencies({
      script: async (apply) => {
        const failed = v2Item({ id: "e1", type: "error", runId: "compact", failure: { class: "provider_error", message: "Context limit unavailable" } });
        expect(await apply(state(2, [prior, compactRun("failed")], [failed]))).toBe(false);
      },
    }),
  )).rejects.toThrow("Context limit unavailable");
});
