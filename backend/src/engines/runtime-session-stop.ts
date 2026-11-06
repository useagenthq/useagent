// Reloads a thread's retained provider session after config it read at start
// changed: OpenCode's model limits, Codex's config.toml (the runtime never asks
// either to reload). The thread's provider session is detached, and the next
// turn starts a fresh one with the new config. The plane runs one turn per
// thread and detaches only while preparing that turn, after reading the thread
// idle, so no turn can start in between.
import { setTimeout as delay } from "node:timers/promises";
import { SANDBOX_NAME_PREFIX } from "../sandboxes/sandbox-names";
import type { SandboxHandle } from "../sandboxes/provider";
import { requestRuntimeEnvironment } from "./runtime-environment-client";
import { dispatchRuntimeCommand } from "./runtime-dispatch";
import { awaitRuntimeOperation } from "./runtime-operation";
import { readRuntimeThread } from "./runtime-thread-read";
import { activeV2ProviderSession, latestV2Run } from "./runtime-v2-view";
import {
  buildV2ProviderSessionDetach,
  runtimeCommandRefused,
  stableRuntimeId,
  v2RunSettled,
  type RuntimeCommand,
  type V2Projection,
} from "./runtime-v2-wire";

const RUNTIME_POLL_INTERVAL_MS = 125;
const SESSION_RELOAD_DEADLINE_MS = 10_000;
const ACTIVE_SESSION_STATUSES = new Set(["starting", "running", "waiting"]);

/** Every attempt is its own command: the runtime keeps a refused command id refused. */
export function buildRuntimeSessionDetachCommand(
  threadId: string,
  providerSessionId: string,
  revision: string,
  reason: string,
): RuntimeCommand & { readonly threadId: string } {
  return {
    ...buildV2ProviderSessionDetach({
      commandId: stableRuntimeId(`${SANDBOX_NAME_PREFIX}-session-detach`, `${revision}-${threadId}`),
      threadId,
      providerSessionId,
      reason,
    }),
    threadId,
  };
}

export interface SessionReloadDependencies {
  readonly requestEnvironment: typeof requestRuntimeEnvironment;
  readonly dispatch: typeof dispatchRuntimeCommand;
  readonly wait: (signal: AbortSignal) => Promise<void>;
}

const sessionReloadDependencies: SessionReloadDependencies = {
  requestEnvironment: requestRuntimeEnvironment,
  dispatch: dispatchRuntimeCommand,
  async wait(signal) {
    await delay(RUNTIME_POLL_INTERVAL_MS, undefined, { signal });
  },
};

const awaitReloadOperation = <T>(operation: Promise<T>, signal: AbortSignal): Promise<T> =>
  awaitRuntimeOperation(operation, signal, async () => {});

function assertIdle(projection: V2Projection, change: string, phase: string): void {
  const latest = latestV2Run(projection);
  if (latest && !v2RunSettled(latest.status)) {
    throw new Error(`${change} changed while the retained native turn is running${phase}`);
  }
  const busy = projection.providerSessions.find((session) => ACTIVE_SESSION_STATUSES.has(session.status));
  if (busy) throw new Error(`${change} changed while the retained session is ${busy.status}${phase}`);
}

/**
 * Detaches the thread's idle retained session so it restarts with the changed
 * config. Resolves true when the change is applied (the session left the
 * thread, or there was none), false when the runtime refused the detach: the
 * turn then runs on the retained session as it is, the change stays
 * unacknowledged, and a later turn tries again.
 */
export async function reloadRetainedSession(input: {
  readonly sandbox: SandboxHandle;
  readonly signal: AbortSignal;
  readonly threadId: string;
  readonly threadExists: boolean;
  /** What changed, as the detach reason and errors name it: "OpenCode model limits", "Codex configuration". */
  readonly change: string;
  readonly changed: boolean;
  readonly revision?: string | null;
  readonly deadlineMs?: number;
  readonly dependencies?: SessionReloadDependencies;
}): Promise<boolean> {
  if (!input.threadExists || !input.changed) return true;
  if (!input.revision) throw new Error(`${input.change} refresh command state is missing`);

  const dependencies = input.dependencies ?? sessionReloadDependencies;
  const deadline = AbortSignal.timeout(input.deadlineMs ?? SESSION_RELOAD_DEADLINE_MS);
  const signal = AbortSignal.any([input.signal, deadline]);
  const readThread = async () => (await awaitReloadOperation(
    readRuntimeThread(input.sandbox, input.threadId, signal, dependencies.requestEnvironment),
    signal,
  )).projection;

  try {
    const projection = await readThread();
    assertIdle(projection, input.change, "");
    const session = activeV2ProviderSession(projection);
    if (!session) return true;
    try {
      await awaitReloadOperation(
        dependencies.dispatch(
          input.sandbox,
          buildRuntimeSessionDetachCommand(input.threadId, session.id, `${input.revision}-${crypto.randomUUID()}`, `${input.change} changed.`),
          signal,
        ),
        signal,
      );
    } catch (error) {
      input.signal.throwIfAborted();
      deadline.throwIfAborted();
      // A session that left the thread (a lost answer to a detach that landed,
      // or a release of its own) is as good as detached.
      const after = await readThread();
      if (!after.providerSessions.some((candidate) => candidate.id === session.id)) return true;
      if (!runtimeCommandRefused(error)) {
        const latest = latestV2Run(after);
        if ((latest && !v2RunSettled(latest.status)) || after.providerSessions.some((candidate) => ACTIVE_SESSION_STATUSES.has(candidate.status))) {
          throw new Error(`${input.change} changed but the retained session reactivated before the detach`);
        }
        throw error;
      }
      console.warn(
        `[runtime] the runtime refused the session detach for ${input.threadId}; ` +
          `the retained session keeps its old ${input.change} until a later turn: ${error.message}`,
      );
      return false;
    }
    for (;;) {
      const after = await readThread();
      assertIdle(after, input.change, " during its reload");
      if (!after.providerSessions.some((candidate) => candidate.id === session.id)) return true;
      await awaitReloadOperation(dependencies.wait(signal), signal);
    }
  } catch (error) {
    if (input.signal.aborted) throw input.signal.reason;
    if (deadline.aborted) {
      throw new Error(`Timed out waiting for the retained session to stop after the ${input.change} changed`);
    }
    throw error;
  }
}
