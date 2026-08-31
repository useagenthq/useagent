import {
  SESSION_STARTED_EVENT_TYPE,
  type HarnessRuntime,
  type HarnessSession,
  type ExecutionCapabilitySnapshot,
  type NegotiatedCapabilities,
  type ProviderSessionBinding,
} from "@useagent/agent-harness/canonical";
import type {
  HarnessResult,
  ProviderDriver,
} from "@useagent/agent-harness/control";
import { providerProtocolIdentity } from "@useagent/agent-harness/control";
import { recordProviderEvent, type ProviderEventInput } from "../runs/provider-events";
import {
  RUN_TIMING_OUTCOMES,
  RUN_TIMING_STAGES,
} from "../runs/run-timing";
import type { EngineRunContext } from "./types";

export interface ProviderSessionEventIdentity {
  readonly provider: string;
  readonly source: string;
  readonly resumed: boolean;
}

export interface EstablishProviderSessionInput {
  readonly driver: ProviderDriver;
  readonly ctx: Pick<
    EngineRunContext,
    | "runId"
    | "threadId"
    | "engineSessionId"
    | "providerSession"
    | "model"
    | "signal"
    | "timing"
  >;
  readonly runtime: HarnessRuntime;
  readonly capabilities: NegotiatedCapabilities;
  readonly executionCapabilities: ExecutionCapabilitySnapshot;
  readonly generation?: number;
  readonly authEpoch?: string | null;
  readonly startMetadata?: Record<string, unknown>;
  readonly priorSessionId?: string;
  readonly persistSession: (session: HarnessSession) => Promise<void>;
}

export interface EstablishedProviderSession {
  readonly session: HarnessSession;
  readonly resumed: boolean;
}

export interface ProviderSessionExpectation {
  readonly provider: string;
  readonly protocol: string;
  readonly generation: number;
  readonly runtime: HarnessRuntime;
  readonly authEpoch?: string | null;
}

/** Match all durable authority fields before a provider-native id is reused.
 * A typed mismatch never falls back to the legacy mirror. Only a row with no
 * typed binding may use that mirror during the migration window. */
export function resumableProviderSessionId(input: {
  readonly binding?: ProviderSessionBinding | null;
  readonly legacySessionId?: string | null;
  readonly expected: ProviderSessionExpectation;
}): string | undefined {
  const binding = input.binding;
  if (!binding) return input.legacySessionId || undefined;
  const expectedAuthEpoch = input.expected.authEpoch ?? null;
  return binding.provider === input.expected.provider &&
    binding.protocol === input.expected.protocol &&
    binding.generation === input.expected.generation &&
    binding.runtime.kind === input.expected.runtime.kind &&
    binding.runtime.id === input.expected.runtime.id &&
    binding.authEpoch === expectedAuthEpoch
    ? binding.nativeSessionId
    : undefined;
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
    protocolVersion: providerProtocolIdentity(input.driver.descriptor.protocol),
    capabilities: input.capabilities,
    executionCapabilities: input.executionCapabilities,
    generation: input.generation ?? 1,
  };
}

async function persistProviderSession(
  input: EstablishProviderSessionInput,
  session: HarnessSession,
): Promise<void> {
  const endPersist = input.ctx.timing?.begin(RUN_TIMING_STAGES.providerSessionPersist);
  try {
    await input.persistSession(session);
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
  const protocol = providerProtocolIdentity(input.driver.descriptor.protocol);
  const generation = input.generation ?? 1;
  const authEpoch = input.authEpoch ?? null;
  const priorSessionId = resumableProviderSessionId({
    binding: input.ctx.providerSession,
    legacySessionId: input.priorSessionId ?? input.ctx.engineSessionId,
    expected: {
      provider: input.driver.provider,
      protocol,
      generation,
      runtime: input.runtime,
      authEpoch,
    },
  });
  if (priorSessionId) {
    const candidate = resumableSession(input, priorSessionId);
    const endResume = input.ctx.timing?.begin(RUN_TIMING_STAGES.providerSessionResume);
    let resumed: Awaited<ReturnType<ProviderDriver["resume"]>>;
    try {
      resumed = await input.driver.resume({
        session: candidate,
        metadata: input.startMetadata,
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
        session: {
          ...resumed.value,
          capabilities: input.capabilities,
          executionCapabilities: input.executionCapabilities,
        },
        resumed: true,
      } satisfies EstablishedProviderSession;
      await persistProviderSession(input, established.session);
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
    session: {
      ...started.value,
      capabilities: input.capabilities,
      executionCapabilities: input.executionCapabilities,
    },
    resumed: false,
  } satisfies EstablishedProviderSession;
  await persistProviderSession(input, established.session);
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
      resumed: identity.resumed,
      capabilities: session.capabilities,
      ...(session.executionCapabilities
        ? { executionCapabilities: session.executionCapabilities }
        : {}),
    },
  };
}

/** Session capability truth is an execution prerequisite, not best-effort
 * telemetry. The sequencer remains recoverable, but this caller observes and
 * propagates a persistence failure before any provider prompt is dispatched. */
export async function recordProviderSessionStarted(
  ctx: Pick<EngineRunContext, "runId" | "threadId">,
  session: HarnessSession,
  identity: ProviderSessionEventIdentity,
  persist: typeof recordProviderEvent = recordProviderEvent,
): Promise<void> {
  await persist(providerSessionStartedEvent(ctx, session, identity), {
    critical: true,
    required: true,
  });
}
