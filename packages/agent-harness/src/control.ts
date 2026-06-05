/**
 * Provider-neutral harness CONTROL seam (north star Phase 2 "HarnessAdapter
 * Contract", Stage-1 MINIMAL subset: capabilities / cancel / reconcile).
 *
 * These are pure domain types: they carry only string handles and MUST NOT
 * import a sandbox/provider SDK, a database, or any product runtime. Provider-
 * specific translation lives in the adapter. Unsupported behavior returns a typed
 * `unsupported_capability` result; it must never silently no-op or throw an
 * unclassified exception.
 *
 * Extracted from `backend/src/engines/types.ts` into `@useagent/agent-harness` so
 * both the backend and a future independent consumer can depend on the control
 * contract without importing useAgent product code. `types.ts` keeps the useAgent-
 * specific engine surface (EmitStep, EngineRunContext, EngineAdapter, prompt
 * composition) and re-exports these types for backward compatibility.
 */

import type {
  HarnessRuntime,
  HarnessSession,
  NegotiatedCapabilities,
  ProviderId,
} from "./canonical";

/** Provider-native capability detection (a subset is meaningful in Stage 1;
 *  fields describe what the HARNESS supports natively, not what useAgent already
 *  projects). */
export interface HarnessCapabilities {
  resume: boolean;
  cancel: boolean;
  streaming: "none" | "text" | "parts";
  authoritativeHistory: boolean;
  childSessions: boolean;
  approvals: boolean;
  questions: boolean;
  reasoning: boolean;
  todos: boolean;
  patches: boolean;
  usage: boolean;
}

/** Enough native identity to address one live session. No provider SDK types -
 *  the adapter resolves these strings to a concrete sandbox/server. */
export interface HarnessSessionHandle {
  provider: string;
  /** Native harness session id (opencode `ses_*`). */
  sessionId: string;
  /** Sandbox instance holding the resident harness. */
  sandboxId: string;
}

/** Optional watermark for reconcile - our last recorded activity (epoch ms), so
 *  the adapter only reports a completion strictly newer than what we have. */
export interface HarnessCheckpoint {
  sinceMs?: number;
}

/** Returned instead of throwing when a capability is not supported by this
 *  provider - the caller branches on it explicitly. */
export interface HarnessUnsupported {
  status: "unsupported_capability";
  provider: string;
  capability: string;
  message?: string;
}

/** Result of a control operation (e.g. cancel). Classified, never a bare throw. */
export type HarnessOperationResult =
  | { status: "ok" }
  | { status: "error"; code: string; message: string }
  | HarnessUnsupported;

/** A single native event a reconcile probe surfaces while a run is still
 *  `in_progress`, so the recovery loop can append it to the canonical run and the
 *  timeline advances DURING adoption instead of showing a frozen marker. `id` is
 *  the provider's stable event id (opencode `pe_<partId>`); ingestion upserts on
 *  it, so a re-probe and the live lane never create a duplicate row. */
export interface HarnessInterimEvent {
  id: string;
  provider: string;
  eventType: string;
  sessionId?: string | null;
  messageId?: string | null;
  partId?: string | null;
  callId?: string | null;
  payload?: unknown;
}

/** Result of a reconcile probe - the provider-neutral projection of what the
 *  native session's history shows after an interruption. `in_progress` may carry
 *  the interim events seen since the checkpoint so the caller can keep the
 *  timeline alive while it re-probes; a provider that cannot surface them just
 *  omits the field (graceful degrade, no faked progress). */
export type HarnessReconciliation =
  | { status: "completed"; summary: string }
  | { status: "in_progress"; events?: readonly HarnessInterimEvent[] }
  | { status: "no_change" }
  | { status: "unreachable" }
  | HarnessUnsupported;

/** The Stage-1 minimal harness boundary. Fuller methods (createSession,
 *  submitTurn, subscribe, snapshot, resolveInteraction) are deferred - the
 *  existing EngineAdapter.run drives turns today; this seam adds the typed
 *  control/observability surface the product layer needs. */
export interface HarnessAdapter {
  readonly provider: string;
  /** Provider capability detection. Pass a live handle when session/runtime
   *  metadata is available; adapters without per-session routing may ignore it. */
  capabilities(handle?: HarnessSessionHandle): HarnessCapabilities;
  /** Ask the native session to abort. Records product intent at the caller. */
  cancel(
    handle: HarnessSessionHandle,
    reason: string,
  ): Promise<HarnessOperationResult>;
  /** Probe native history after an interruption (see north star Crash Recovery).
   *  Bounded and non-throwing; unreachable is a normal outcome, not an error. */
  reconcile(
    handle: HarnessSessionHandle,
    checkpoint?: HarnessCheckpoint,
  ): Promise<HarnessReconciliation>;
}

export type ProviderDriverCapability =
  | "start"
  | "resume"
  | "reconcile"
  | "steer"
  | "cancel"
  | "modelCapability"
  | "toolGateway";

export type HarnessResult<T> =
  | { status: "ok"; value: T }
  | { status: "error"; code: string; message: string }
  | HarnessUnsupported;

export interface ProviderProtocolDescriptor {
  name: string;
  version?: string;
}

export interface ProviderModelDescriptor {
  id: string;
  displayName?: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
}

export interface ProviderModelCapabilityDescriptor {
  /** `fixed` means the provider chooses one model; `per_turn` means callers may steer it. */
  selection: "fixed" | "per_turn";
  defaultModel?: string;
  availableModels?: readonly ProviderModelDescriptor[];
  /** True only when the provider accepts arbitrary model ids beyond `availableModels`. */
  supportsArbitraryModel?: boolean;
}

export interface ProviderToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface ProviderToolCapabilityDescriptor {
  /** No gateway, provider-native tools, or useAgent-brokered tools. */
  mode: "none" | "provider_native" | "skynet_brokered";
  approval: "none" | "provider" | "skynet";
  tools?: readonly ProviderToolDescriptor[];
}

export interface ProviderDriverDescriptor {
  provider: ProviderId;
  protocol: ProviderProtocolDescriptor;
  /** Reuses the canonical negotiated map; there is no second product capability model. */
  capabilities: NegotiatedCapabilities;
  model: ProviderModelCapabilityDescriptor;
  tools: ProviderToolCapabilityDescriptor;
}

export interface ProviderStartRequest {
  runId: string;
  threadId: string;
  turnId?: string;
  /** Existing runtime where the provider-native session should be created.
   *  Product/runtime provisioning stays outside the pure driver contract. */
  runtime: HarnessRuntime;
  model?: string;
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface ProviderResumeRequest {
  session: HarnessSession;
  checkpoint?: HarnessCheckpoint;
  /** Backend-only runtime metadata required to reconstruct a resident native
   * process after control-plane restart. Never provider/model-visible text. */
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface ProviderReconcileRequest {
  session: HarnessSession;
  checkpoint?: HarnessCheckpoint;
  signal?: AbortSignal;
}

export type ProviderSteerInput =
  | { kind: "prompt"; text: string; model?: string }
  | { kind: "command"; name: string; arguments?: string }
  | { kind: "approval"; approvalId: string; decision: string }
  | { kind: "question"; questionId: string; answers: readonly (readonly string[])[] };

export interface ProviderSteerRequest {
  /** Product-owned turn identity. Drivers may use it for stable native command/message ids,
   *  but never allocate canonical event ids or delivery sequence numbers from it. */
  runId: string;
  threadId: string;
  turnId?: string;
  session: HarnessSession;
  input: ProviderSteerInput;
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface ProviderDriver {
  readonly provider: ProviderId;
  readonly descriptor: ProviderDriverDescriptor;
  start(request: ProviderStartRequest): Promise<HarnessResult<HarnessSession>>;
  resume(request: ProviderResumeRequest): Promise<HarnessResult<HarnessSession>>;
  /** Optional while legacy providers still own their history probe. New native
   *  drivers expose recovery here so lifecycle authority does not split across
   *  a second provider registry. */
  reconcile?(request: ProviderReconcileRequest): Promise<HarnessReconciliation>;
  steer(request: ProviderSteerRequest): Promise<HarnessOperationResult>;
  cancel(session: HarnessSession, reason: string): Promise<HarnessOperationResult>;
}

/** Compatibility projection onto the legacy control facade. The canonical driver
 * descriptor remains authoritative; `todos` and `patches` retain their legacy
 * names while mapping to the canonical plan and file-diff surfaces, and legacy
 * `childSessions` means the provider-NATIVE child projection (the gateway
 * child_session tools are engine-independent and not a harness capability). */
export function providerDriverHarnessCapabilities(
  driver: Pick<ProviderDriver, "descriptor">,
): HarnessCapabilities {
  const capabilities = driver.descriptor.capabilities;
  const streaming = capabilities.toolProgress || capabilities.fileDiffs
    ? "parts"
    : capabilities.streamingText
      ? "text"
      : "none";
  return {
    resume: capabilities.resume,
    cancel: capabilities.stop,
    streaming,
    authoritativeHistory: capabilities.reconcile,
    childSessions: capabilities.nativeChildProjection,
    approvals: capabilities.approvals,
    questions: capabilities.questions,
    reasoning: capabilities.reasoning,
    todos: capabilities.plans,
    patches: capabilities.fileDiffs,
    usage: capabilities.usage,
  };
}

export function providerDriverUnsupported(
  provider: ProviderId,
  capability: ProviderDriverCapability,
  message?: string,
): HarnessUnsupported {
  return {
    status: "unsupported_capability",
    provider,
    capability,
    ...(message ? { message } : {}),
  };
}

function isFunction(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const MODEL_SELECTION_MODES = new Set(["fixed", "per_turn"]);
const TOOL_MODES = new Set(["none", "provider_native", "skynet_brokered"]);
const TOOL_APPROVAL_MODES = new Set(["none", "provider", "skynet"]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function validateProviderDriver(driver: unknown): HarnessOperationResult {
  if (!isRecord(driver)) {
    return {
      status: "error",
      code: "invalid_provider_driver",
      message: "provider driver must be an object",
    };
  }

  const provider = driver.provider;
  const descriptor = driver.descriptor;
  if (typeof provider !== "string" || provider.length === 0) {
    return {
      status: "error",
      code: "invalid_provider_driver",
      message: "provider driver must declare a provider",
    };
  }
  if (!isRecord(descriptor)) {
    return {
      status: "error",
      code: "invalid_provider_descriptor",
      message: `provider driver '${provider}' must declare a descriptor`,
    };
  }
  if (descriptor.provider !== provider) {
    return {
      status: "error",
      code: "provider_descriptor_mismatch",
      message: `provider driver '${provider}' must use a matching descriptor provider`,
    };
  }
  if (
    !isRecord(descriptor.protocol) ||
    typeof descriptor.protocol.name !== "string" ||
    descriptor.protocol.name.length === 0
  ) {
    return {
      status: "error",
      code: "invalid_provider_protocol",
      message: `provider driver '${provider}' must declare a protocol name`,
    };
  }
  if (!isRecord(descriptor.capabilities)) {
    return {
      status: "error",
      code: "invalid_provider_capabilities",
      message: `provider driver '${provider}' must declare canonical capabilities`,
    };
  }
  if (!isRecord(descriptor.model)) {
    return {
      status: "error",
      code: "invalid_model_capability",
      message: `provider driver '${provider}' must declare model capabilities`,
    };
  }
  if (!MODEL_SELECTION_MODES.has(String(descriptor.model.selection))) {
    return {
      status: "error",
      code: "invalid_model_capability",
      message: `provider driver '${provider}' has an invalid model selection mode`,
    };
  }
  if (!isRecord(descriptor.tools)) {
    return {
      status: "error",
      code: "invalid_tool_gateway",
      message: `provider driver '${provider}' must declare a tool gateway descriptor`,
    };
  }
  if (!TOOL_MODES.has(String(descriptor.tools.mode))) {
    return {
      status: "error",
      code: "invalid_tool_gateway",
      message: `provider driver '${provider}' has an invalid tool mode`,
    };
  }
  if (!TOOL_APPROVAL_MODES.has(String(descriptor.tools.approval))) {
    return {
      status: "error",
      code: "invalid_tool_gateway",
      message: `provider driver '${provider}' has an invalid tool approval mode`,
    };
  }
  if (
    "availableModels" in descriptor.model &&
    (!Array.isArray(descriptor.model.availableModels) ||
      descriptor.model.availableModels.some(
        (model) => !isRecord(model) || !isNonEmptyString(model.id),
      ))
  ) {
    return {
      status: "error",
      code: "invalid_model_capability",
      message: `provider driver '${provider}' has an invalid model catalog`,
    };
  }

  for (const method of ["start", "resume", "steer", "cancel"] as const) {
    if (!isFunction(driver[method])) {
      return {
        status: "error",
        code: "missing_provider_method",
        message: `provider driver '${provider}' must implement ${method}`,
      };
    }
  }

  if ("reconcile" in driver && !isFunction(driver.reconcile)) {
    return {
      status: "error",
      code: "invalid_provider_method",
      message: `provider driver '${provider}' must implement reconcile as a function`,
    };
  }

  return { status: "ok" };
}
