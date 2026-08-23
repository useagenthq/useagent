import {
  SESSION_STARTED_EVENT_TYPE,
  type HarnessRuntime,
  type HarnessSession,
  type NegotiatedCapabilities,
} from "@useagent/agent-harness/canonical";
import type {
  HarnessResult,
  ProviderDriver,
} from "@useagent/agent-harness/control";
import type { ProviderEventInput } from "../runs/provider-events";
import {
  RUN_TIMING_OUTCOMES,
  RUN_TIMING_STAGES,
} from "../runs/run-timing";
import type { EngineRunContext } from "./types";

export interface ProviderSessionEventIdentity {
  readonly provider: string;
  readonly source: string;
}

export interface EstablishProviderSessionInput {
  readonly driver: ProviderDriver;
  readonly ctx: Pick<
    EngineRunContext,
    "runId" | "threadId" | "engineSessionId" | "model" | "signal" | "timing"
  >;
  readonly runtime: HarnessRuntime;
  readonly capabilities: NegotiatedCapabilities;
  readonly generation?: number;
  readonly startMetadata?: Record<string, unknown>;
  readonly priorSessionId?: string;
  readonly persistSession: (nativeSessionId: string) => Promise<void>;
}

export interface EstablishedProviderSession {
  readonly session: HarnessSession;
  readonly resumed: boolean;
}

function operationError(
  operation: "start" | "resume",
  result: Exclude<HarnessResult<HarnessSession>, { status: "ok" }>,
): Error {
  const detail = result.message ? `: ${result.message}` : "";
  const provider = result.status === "unsupported_capability" ? result.provider : "provider";
  return new Error(`${provider} ${operation} ${result.status}${detail}`);
}

function resumableSession(
  input: EstablishProviderSessionInput,
  nativeSessionId: string,
): HarnessSession {
  return {
    provider: input.driver.provider,
    nativeSessionId,
    runtime: input.runtime,
    protocolVersion: input.driver.descriptor.protocol.name,
    capabilities: input.capabilities,
    generation: input.generation ?? 1,
  };
}

async function persistProviderSession(
  input: EstablishProviderSessionInput,
  nativeSessionId: string,
): Promise<void> {
  const endPersist = input.ctx.timing?.begin(RUN_TIMING_STAGES.providerSessionPersist);
  try {
    await input.persistSession(nativeSessionId);
    endPersist?.(RUN_TIMING_OUTCOMES.success);
  } catch (error) {
    endPersist?.(
      input.ctx.signal.aborted
        ? RUN_TIMING_OUTCOMES.aborted
        : RUN_TIMING_OUTCOMES.failure,
    );
    throw error;
  }
}

/**
 * Resolve the provider-owned session lifecycle after the product has provisioned a runtime.
 * A stale native id is replaced only when the driver classifies it as `session_invalid`;
 * transport/runtime failures remain failures so a healthy retained session is never silently
 * forked into a second conversation. Persistence completes before establishment returns to the
 * adapter, so no caller can dispatch against a session that was not durably recorded.
 */
export async function establishProviderSession(
  input: EstablishProviderSessionInput,
): Promise<EstablishedProviderSession> {
  const priorSessionId = input.priorSessionId ?? input.ctx.engineSessionId;
  if (priorSessionId) {
    const candidate = resumableSession(input, priorSessionId);
    const endResume = input.ctx.timing?.begin(RUN_TIMING_STAGES.providerSessionResume);
    let resumed: Awaited<ReturnType<ProviderDriver["resume"]>>;
    try {
      resumed = await input.driver.resume({
        session: candidate,
        signal: input.ctx.signal,
      });
    } catch (error) {
      endResume?.(
        input.ctx.signal.aborted
          ? RUN_TIMING_OUTCOMES.aborted
          : RUN_TIMING_OUTCOMES.failure,
      );
      throw error;
    }
    if (resumed.status === "ok") {
      endResume?.(RUN_TIMING_OUTCOMES.success);
      const established = {
        session: { ...resumed.value, capabilities: input.capabilities },
        resumed: true,
      } satisfies EstablishedProviderSession;
      await persistProviderSession(input, established.session.nativeSessionId);
      return established;
    }
    if (resumed.status !== "error" || resumed.code !== "session_invalid") {
      endResume?.(RUN_TIMING_OUTCOMES.failure);
      throw operationError("resume", resumed);
    }
    endResume?.(RUN_TIMING_OUTCOMES.miss);
  }

  const endStart = input.ctx.timing?.begin(RUN_TIMING_STAGES.providerSessionStart);
  let started: Awaited<ReturnType<ProviderDriver["start"]>>;
  try {
    started = await input.driver.start({
      runId: input.ctx.runId,
      threadId: input.ctx.threadId ?? input.ctx.runId,
      runtime: input.runtime,
      model: input.ctx.model,
      metadata: input.startMetadata,
      signal: input.ctx.signal,
    });
  } catch (error) {
    endStart?.(
      input.ctx.signal.aborted
        ? RUN_TIMING_OUTCOMES.aborted
        : RUN_TIMING_OUTCOMES.failure,
    );
    throw error;
  }
  if (started.status !== "ok") {
    endStart?.(RUN_TIMING_OUTCOMES.failure);
    throw operationError("start", started);
  }
  endStart?.(RUN_TIMING_OUTCOMES.success);
  const established = {
    session: { ...started.value, capabilities: input.capabilities },
    resumed: false,
  } satisfies EstablishedProviderSession;
  await persistProviderSession(input, established.session.nativeSessionId);
  return established;
}

/** Stable native frame translated by the existing canonical outbox into `session.started`. */
export function providerSessionStartedEvent(
  ctx: Pick<EngineRunContext, "runId" | "threadId">,
  session: HarnessSession,
  identity: ProviderSessionEventIdentity,
): ProviderEventInput {
  return {
    id: `${ctx.runId}:${session.nativeSessionId}:session`,
    runId: ctx.runId,
    threadId: ctx.threadId ?? ctx.runId,
    provider: identity.provider,
    eventType: SESSION_STARTED_EVENT_TYPE,
    nativeSessionId: session.nativeSessionId,
    payload: {
      source: identity.source,
      capabilities: session.capabilities,
    },
  };
}
