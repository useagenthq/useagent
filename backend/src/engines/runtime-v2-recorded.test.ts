// RECORDED: these frames come from a running V2 runtime (the spike build), not
// from the contract. See test/fixtures/runtime-v2/*.json for where each came from.
import { describe, expect, test } from "bun:test";
import recorded from "../../test/fixtures/runtime-v2/codex-turn-provider-failure.json";
import { runtimeActivityRevision } from "./runtime-orchestration";
import { applyV2StreamItem, type V2MirrorState } from "./runtime-v2-mirror";
import { runtimeThreadView } from "./runtime-v2-view";
import { decodeV2ThreadStreamItem, runtimeCommandRefused, runtimeRpcErrorFromExit } from "./runtime-v2-wire";
import { createNoProgressWatchdog, NoProgressError } from "./turn-no-progress";
import { SANDBOX_NAME_PREFIX } from "../sandboxes/sandbox-names";

const values = recorded.subscribeThreadValues as unknown[];

function replay() {
  let state: V2MirrorState | null = null;
  const views = [];
  for (const value of values) {
    const item = decodeV2ThreadStreamItem(value);
    if (!item) throw new Error(`a recorded value did not decode: ${JSON.stringify(value).slice(0, 200)}`);
    const next = applyV2StreamItem(state, item, recorded.threadId);
    state = next.state;
    if (next.changed && state) views.push(runtimeThreadView({ snapshotSequence: state.sequence, projection: state.projection }));
  }
  return views;
}

describe("a recorded protocol 2 turn", () => {
  test("every value the runtime sent decodes and applies", () => {
    const views = replay();
    expect(views.length).toBeGreaterThan(10);
    const last = views.at(-1)!;
    expect(last.thread.latestTurn).toMatchObject({
      state: "error",
      userMessageId: recorded.userMessageId,
      error: expect.stringContaining("401 Unauthorized"),
    });
    expect(last.thread.messages.map((message) => [message.role, message.text])).toEqual([["user", "Say hello in one word."]]);
    expect(last.thread.session).toMatchObject({ status: "ready", activeTurnId: null });
  });

  test("the provider's retries are warnings the no-progress watchdog counts; its final failure is the turn's error", () => {
    const seen = new Map<string, string>();
    const kinds: string[] = [];
    const watchdog = createNoProgressWatchdog(Number.POSITIVE_INFINITY);
    let stopped: unknown = null;
    for (const view of replay()) {
      for (const activity of view.thread.activities) {
        const revision = runtimeActivityRevision(activity);
        if (seen.get(activity.id) === revision) continue;
        seen.set(activity.id, revision);
        kinds.push(activity.kind);
        try {
          watchdog.observeActivity(activity);
        } catch (error) {
          stopped ??= error;
        }
      }
    }
    watchdog.dispose();
    expect(kinds.filter((kind) => kind === "runtime.warning").length).toBe(9);
    expect(kinds.at(-1)).toBe("runtime.error");
    expect(stopped).toBeInstanceOf(NoProgressError);
    expect((stopped as Error).message).toContain("retry attempt");
  });

  test("a dispatch is answered with its sequence and a refusal names the runtime's reason", () => {
    expect((recorded.dispatchReceiptFrame as { exit: { value: unknown } }).exit.value).toEqual({ sequence: expect.any(Number) });
    const error = runtimeRpcErrorFromExit("orchestration.dispatchCommand", recorded.dispatchRefusalFrame.exit);
    expect(runtimeCommandRefused(error)).toBe(true);
    expect(error.detail).toBe(`Provider session ps-nope does not belong to thread ${SANDBOX_NAME_PREFIX}-thread-probe.`);
    expect(error.causeTags).toEqual(["Fail", "OrchestrationV2DispatchCommandError", "OrchestratorDispatchError"]);
  });
});
