import { createHash, randomUUID } from "node:crypto";
import { getArtifactForOrg, toArtifactDescriptor, type ArtifactRecord } from "../../artifacts/repo";
import { withFinishedWorkMaterializer } from "../../runs/finished-work-materialization-context";
import { withFinishedWorkSessionLocks } from "../../runs/finished-work-lock";
import {
  listFinishedWorkForRun,
  openFinishedWorkObligation,
  recordFinishedWorkMaterialization,
  recordFinishedWorkReceipt,
  resolveFinishedWorkObligation,
  type FinishedWorkObligationRecord,
  type FinishedWorkReceiptRecord,
} from "../../runs/finished-work-repo";
import { finishedWorkRolloutMode } from "../../runs/finished-work-rollout";
import { providerEventExists, recordProviderEvent } from "../../runs/provider-events";
import {
  argumentsWithoutApproval,
  consumeGatewayOperationApproval,
} from "./approval-capability";
import { AUTOMATION_APPROVAL_REQUIRED_TOOL_NAMES } from "./automation-tools";
import {
  advertisedChildSessionTools,
  childSessionToolsEnabled,
  gatewayToolListOptionsFor,
} from "./child-session-tools";
import {
  executeGatewayMetaTool,
  GATEWAY_META_TOOLS,
  gatewayCompactToolListEnabled,
  isGatewayMetaToolName,
} from "./gateway-meta-tools";
import {
  ADDITIONAL_APPROVAL_REQUIRED_TOOL_NAMES,
  ALL_OPERATIONS,
  ALL_TOOL_FAMILIES,
  BASE_TOOL_FAMILIES,
  CHILD_SESSION_TOOL_NAMES,
  GATEWAY_APPROVAL_REQUIRED_TOOL_NAMES,
  SLACK_FAMILY,
  TOOL_ALIASES,
} from "./operation-families";
import { SLACK_TOOLS } from "./slack-tools";
import type { ToolTokenClaims } from "./token";

import type {
  GatewayToolDescriptor,
  GatewayToolExecutionContext,
  GatewayToolExecutor,
  ToolCallResult,
} from "./descriptor";
import {
  completionEffectForCall,
  type ResolvedCompletionEffect,
} from "./operation-completion-effect";

export type {
  GatewayToolDescriptor,
  GatewayToolExecutionContext,
  GatewayToolExecutor,
} from "./descriptor";
export { GATEWAY_APPROVAL_REQUIRED_TOOL_NAMES } from "./operation-families";

type GatewayCompletionEventRecorder = typeof recordProviderEvent;
let completionEventRecorderOverride: GatewayCompletionEventRecorder | null = null;
const inFlightCompletionExecutions = new Map<string, Promise<unknown>>();

/** Test-only seam for proving post-mutation event reconciliation. */
export function setGatewayCompletionEventRecorderForTest(
  recorder: GatewayCompletionEventRecorder | null,
): void {
  completionEventRecorderOverride = recorder;
}

export interface GatewayToolListOptions {
  readonly childSessions: boolean;
  readonly slack: boolean;
  readonly productChildThreads?: boolean;
  readonly orgId?: string | null;
}

export function baseGatewayToolDescriptors(): readonly GatewayToolDescriptor[] {
  return BASE_TOOL_FAMILIES.flatMap<GatewayToolDescriptor>((family) => [...family.tools]);
}

export function gatewayMetaToolDescriptors(): readonly GatewayToolDescriptor[] {
  return GATEWAY_META_TOOLS;
}
export interface GatewayToolCatalogDescriptor {
  readonly category: string; readonly descriptor: GatewayToolDescriptor;
  readonly condition: "always" | "child_session" | "slack";
}
/** Browser-safe catalog metadata still starts from the execution registry. The
 * caller decides deployment/current-run availability; schemas and executors do
 * not leave this module. */
export function gatewayToolCatalogDescriptors(): readonly GatewayToolCatalogDescriptor[] {
  return ALL_TOOL_FAMILIES.flatMap((family) =>
    family.tools.map((descriptor) => ({
      category: family.category,
      descriptor,
      condition: family === SLACK_FAMILY
        ? "slack" as const
        : family.category === "child_sessions"
          ? "child_session" as const
          : "always" as const,
    }))
  );
}

export function advertisedGatewayToolDescriptors(
  options: GatewayToolListOptions,
): readonly GatewayToolDescriptor[] {
  return [
    ...BASE_TOOL_FAMILIES.flatMap<GatewayToolDescriptor>((family) =>
      family.category === "child_sessions"
        ? (!options.childSessions ? [] : [...advertisedChildSessionTools(options.productChildThreads, options.orgId ?? null)])
        : [...family.tools],
    ),
    ...(options.slack ? SLACK_TOOLS : []),
  ].map(advertisedDescriptor);
}

export function gatewayToolListDescriptors(
  options: GatewayToolListOptions,
  env: Readonly<Record<string, string | undefined>> = process.env,
): readonly GatewayToolDescriptor[] {
  const tools = gatewayCompactToolListEnabled(env)
    ? GATEWAY_META_TOOLS
    : advertisedGatewayToolDescriptors(options);
  return tools.map(advertisedDescriptor);
}

function availableGatewayToolDescriptors(
  options: GatewayToolListOptions,
): readonly GatewayToolDescriptor[] {
  return [...GATEWAY_META_TOOLS, ...advertisedGatewayToolDescriptors(options)].map(
    advertisedDescriptor,
  );
}

function advertisedDescriptor(tool: GatewayToolDescriptor): GatewayToolDescriptor {
  const { completionEffect: _completionEffect, ...advertised } = tool;
  return advertised;
}

export type GatewayToolExecution =
  | { readonly matched: false }
  | { readonly matched: true; readonly result: unknown };

/** Exact registry metadata, shared by discovery and the authenticated mint route. */
export function gatewayToolRequiresApproval(name: string): boolean {
  return GATEWAY_APPROVAL_REQUIRED_TOOL_NAMES.has(name) && ALL_OPERATIONS.has(name);
}

/** Whether a tool name is implemented by this gateway process. Permission
 * bridges use this exact registry lookup to allow the RPC round-trip; the
 * gateway still performs run, tenant, and one-shot approval authorization. */
export function isRegisteredGatewayToolName(name: string): boolean {
  return ALL_OPERATIONS.has(TOOL_ALIASES.get(name) ?? name) || isGatewayMetaToolName(name);
}

/** Registered descriptor lookup across every family (conditional included) -
 *  used by approval_request to verify the gated arguments are complete. */
export function advertisedGatewayToolDescriptor(
  name: string,
): GatewayToolDescriptor | null {
  const canonicalName = TOOL_ALIASES.get(name) ?? name;
  for (const family of ALL_TOOL_FAMILIES) {
    const tool = family.tools.find((candidate) => candidate.name === canonicalName);
    if (tool) return tool;
  }
  return null;
}

async function invokeRegisteredOperation(
  executor: GatewayToolExecutor,
  claims: ToolTokenClaims,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (AUTOMATION_APPROVAL_REQUIRED_TOOL_NAMES.has(name)) {
    return executor(claims, name, args);
  }
  // GitHub publication is delegated to the credential-owning primary API.
  // Preserve the opaque capability so that backend atomically consumes it
  // immediately before claiming the durable publication receipt; consuming it
  // in the restricted gateway would make the internal route an approval bypass.
  if (name === "github_pull_request_publish") {
    return executor(claims, name, args);
  }
  if (
    ADDITIONAL_APPROVAL_REQUIRED_TOOL_NAMES.has(name) &&
    !(await consumeGatewayOperationApproval(claims, name, args))
  ) {
    return {
      content: [
        {
          type: "text",
          text: `A valid server-minted one-shot approval capability is required for ${name}. Call approval_request with this tool name and the exact argument object, have the user approve it in the useAgent session view, poll approval_poll for the approvalCapability, then retry ${name} with it.`,
        },
      ],
      structuredContent: { error: "approval_required" },
      isError: true,
    };
  }
  const operationArgs = argumentsWithoutApproval(args);
  return executor(
    claims,
    name,
    name === "knowledge_draft_publish"
      ? { ...operationArgs, confirmPublish: true }
      : operationArgs,
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requestIdentity(context: GatewayToolExecutionContext | undefined): string {
  return JSON.stringify(context?.requestId ?? `direct:${randomUUID()}`);
}

function sourceIdentity(
  claims: ToolTokenClaims,
  canonicalName: string,
  context: GatewayToolExecutionContext | undefined,
): { readonly sourceKey: string; readonly sourceCallId: string } {
  const request = requestIdentity(context);
  return {
    sourceKey: `gateway:${sha256(JSON.stringify([claims.runId, canonicalName, request]))}`,
    sourceCallId: `rpc:${sha256(request)}`,
  };
}

function obligationMatchesEffect(
  obligation: FinishedWorkObligationRecord,
  effect: ResolvedCompletionEffect,
  sourceCallId: string,
): boolean {
  return obligation.sourceKind === "gateway_tool" &&
    obligation.authority === "integration_gateway" &&
    obligation.requirement === effect.requirement &&
    obligation.sourceProvider === "useagent" &&
    obligation.sourceCallId === sourceCallId &&
    obligation.candidateName === effect.candidateName &&
    obligation.targetArtifactId === effect.targetArtifactId;
}

function receiptWire(receipt: FinishedWorkReceiptRecord): Record<string, unknown> {
  return {
    receipt_id: receipt.id,
    kind: receipt.kind,
    authority: receipt.authority,
    artifact_id: receipt.artifactId,
    artifact_revision: receipt.artifactRevision,
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isToolCallResult(value: unknown): value is ToolCallResult {
  return !!value && typeof value === "object" &&
    Array.isArray((value as { readonly content?: unknown }).content);
}

function completionFailure(message: string): ToolCallResult {
  return {
    content: [{ type: "text", text: message }],
    structuredContent: { error: "finished_work_validation_failed" },
    isError: true,
  };
}

async function canonicalArtifactFromResult(
  claims: ToolTokenClaims,
  effect: ResolvedCompletionEffect,
  result: ToolCallResult,
): Promise<ArtifactRecord | null> {
  const artifactValue = result.structuredContent?.artifact;
  if (!artifactValue || typeof artifactValue !== "object" || Array.isArray(artifactValue)) return null;
  const artifactId = (artifactValue as { readonly id?: unknown }).id;
  if (typeof artifactId !== "string" || !artifactId) return null;
  const artifact = await getArtifactForOrg(claims.orgId, artifactId);
  if (!artifact || artifact.threadId !== claims.threadId) return null;
  if (effect.requirement === "artifact_create" && artifact.runId !== claims.runId) return null;
  if (effect.requirement === "artifact_update" && artifact.id !== effect.targetArtifactId) return null;
  return stableJson(artifactValue) === stableJson(toArtifactDescriptor(artifact)) ? artifact : null;
}

async function completedReplayResult(
  claims: ToolTokenClaims,
  receipt: FinishedWorkReceiptRecord,
): Promise<ToolCallResult> {
  const artifact = receipt.artifactId
    ? await getArtifactForOrg(claims.orgId, receipt.artifactId)
    : null;
  if (!artifact || artifact.threadId !== claims.threadId) {
    return completionFailure("The completed gateway operation could not be reconciled to its artifact.");
  }
  return {
    content: [{ type: "text", text: `This gateway operation already completed as artifact ${artifact.id}.` }],
    structuredContent: {
      artifact: toArtifactDescriptor(artifact),
      finished_work_receipt: receiptWire(receipt),
    },
  };
}

async function waiveObligation(
  claims: ToolTokenClaims,
  obligation: FinishedWorkObligationRecord,
): Promise<void> {
  if (obligation.state !== "open") return;
  try {
    await resolveFinishedWorkObligation({
      orgId: claims.orgId,
      runId: claims.runId,
      obligationId: obligation.id,
      state: "waived",
    });
  } catch (error) {
    const current = (await listFinishedWorkForRun(claims.orgId, claims.runId)).obligations.find(
      (candidate) => candidate.id === obligation.id,
    );
    if (current?.state !== "satisfied" && current?.state !== "waived") throw error;
  }
}

async function currentObligation(
  claims: ToolTokenClaims,
  obligationId: string,
): Promise<FinishedWorkObligationRecord> {
  const obligation = (await listFinishedWorkForRun(claims.orgId, claims.runId)).obligations.find(
    (candidate) => candidate.id === obligationId,
  );
  if (!obligation) throw new Error("finished work obligation disappeared");
  return obligation;
}

async function finishMaterializedOperation(
  claims: ToolTokenClaims,
  effect: ResolvedCompletionEffect,
  obligation: FinishedWorkObligationRecord,
  sourceKey: string,
  originalResult?: ToolCallResult,
): Promise<ToolCallResult> {
  const artifactId = obligation.materializedArtifactId;
  const artifactRevision = obligation.materializedArtifactRevision;
  if (!artifactId || artifactRevision === null) {
    throw new Error("finished work obligation has no materialized artifact");
  }
  const artifact = await getArtifactForOrg(claims.orgId, artifactId);
  if (!artifact || artifact.threadId !== claims.threadId) {
    throw new Error("materialized artifact is outside the gateway run scope");
  }
  const descriptor = toArtifactDescriptor(artifact);
  const eventType = effect.requirement === "artifact_create"
    ? "artifact.created"
    : "artifact.revised";
  const eventId = effect.requirement === "artifact_create"
    ? `artifact.created:${artifact.id}`
    : `artifact.revised:${artifact.id}:${artifactRevision}`;
  if (!(await providerEventExists(eventId))) {
    await (completionEventRecorderOverride ?? recordProviderEvent)(
      {
        id: eventId,
        runId: claims.runId,
        threadId: claims.threadId,
        provider: "skynet",
        eventType,
        payload: descriptor,
      },
      { critical: true, required: true },
    );
  }
  const recorded = await recordFinishedWorkReceipt({
    orgId: claims.orgId,
    runId: claims.runId,
    obligationId: obligation.id,
    kind: effect.requirement === "artifact_create" ? "artifact_created" : "artifact_updated",
    authority: effect.authority,
    sourceKey,
    artifactId: artifact.id,
    artifactRevision,
    metadata: {
      byteCount: artifact.sizeBytes,
      digest: artifact.sha256,
      mime: artifact.contentType,
    },
  });
  return originalResult
    ? {
        ...originalResult,
        structuredContent: {
          ...originalResult.structuredContent,
          finished_work_receipt: receiptWire(recorded.row),
        },
      }
    : completedReplayResult(claims, recorded.row);
}

async function invokeSerializedCompletionEffect(
  effect: ResolvedCompletionEffect,
  executor: GatewayToolExecutor,
  claims: ToolTokenClaims,
  canonicalName: string,
  args: Record<string, unknown>,
  identity: { readonly sourceKey: string; readonly sourceCallId: string },
): Promise<unknown> {
  const state = await listFinishedWorkForRun(claims.orgId, claims.runId);
  const related = state.obligations.filter(
    (obligation) => obligation.sourceKey === identity.sourceKey ||
      obligation.sourceKey.startsWith(`${identity.sourceKey}:retry:`),
  );
  for (const obligation of related) {
    if (!obligationMatchesEffect(obligation, effect, identity.sourceCallId)) {
      return completionFailure("The gateway request identity was reused with different completion semantics.");
    }
  }
  const satisfied = related.find((obligation) => obligation.state === "satisfied");
  if (satisfied) {
    const receipt = state.receipts.find((candidate) => candidate.obligationId === satisfied.id);
    if (!receipt) return completionFailure("The completed gateway operation is missing its receipt.");
    return completedReplayResult(claims, receipt);
  }

  const open = related.find((obligation) => obligation.state === "open");
  const sourceKey = open
    ? open.sourceKey
    : related.length === 0
    ? identity.sourceKey
    : `${identity.sourceKey}:retry:${related.length}`;
  let obligation = open ?? (await openFinishedWorkObligation({
    orgId: claims.orgId,
    runId: claims.runId,
    sourceKind: "gateway_tool",
    authority: "integration_gateway",
    sourceKey,
    requirement: effect.requirement,
    sourceProvider: "useagent",
    sourceCallId: identity.sourceCallId,
    candidateName: effect.candidateName,
    targetArtifactId: effect.targetArtifactId,
  })).row;

  if (obligation.materializedArtifactId) {
    try {
      return await finishMaterializedOperation(claims, effect, obligation, sourceKey);
    } catch (error) {
      const message = error instanceof Error ? error.message : "completion reconciliation failed";
      return completionFailure(`The committed gateway operation is awaiting reconciliation: ${message}`);
    }
  }

  let result: unknown;
  try {
    result = await withFinishedWorkMaterializer(
      async (artifact, exec) => {
        obligation = await recordFinishedWorkMaterialization({
          orgId: claims.orgId,
          runId: claims.runId,
          obligationId: obligation.id,
          artifactId: artifact.id,
          artifactRevision: artifact.workpieceRevision,
        }, exec);
      },
      () => invokeRegisteredOperation(executor, claims, canonicalName, args),
    );
  } catch (error) {
    obligation = await currentObligation(claims, obligation.id);
    if (obligation.materializedArtifactId) {
      try {
        return await finishMaterializedOperation(claims, effect, obligation, sourceKey);
      } catch (reconcileError) {
        const message = reconcileError instanceof Error
          ? reconcileError.message
          : "completion reconciliation failed";
        return completionFailure(`The committed gateway operation is awaiting reconciliation: ${message}`);
      }
    }
    await waiveObligation(claims, obligation);
    const message = error instanceof Error ? error.message : "gateway tool execution failed";
    return completionFailure(`The gateway operation failed before completion was recorded: ${message}`);
  }

  obligation = await currentObligation(claims, obligation.id);
  if (!isToolCallResult(result) || result.isError) {
    if (obligation.materializedArtifactId) {
      try {
        return await finishMaterializedOperation(claims, effect, obligation, sourceKey);
      } catch (error) {
        const message = error instanceof Error ? error.message : "completion reconciliation failed";
        return completionFailure(`The committed gateway operation is awaiting reconciliation: ${message}`);
      }
    }
    await waiveObligation(claims, obligation);
    return result;
  }

  const artifact = await canonicalArtifactFromResult(claims, effect, result);
  if (!artifact) {
    await waiveObligation(claims, obligation);
    return completionFailure(
      "The gateway operation returned artifact data that did not match the trusted artifact store.",
    );
  }
  if (!obligation.materializedArtifactId) {
    try {
      obligation = await recordFinishedWorkMaterialization({
        orgId: claims.orgId,
        runId: claims.runId,
        obligationId: obligation.id,
        artifactId: artifact.id,
        artifactRevision: artifact.workpieceRevision,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "materialization checkpoint failed";
      return completionFailure(`The committed gateway operation is awaiting reconciliation: ${message}`);
    }
  }
  try {
    return await finishMaterializedOperation(claims, effect, obligation, sourceKey, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "receipt reconciliation failed";
    return completionFailure(`The committed gateway operation is awaiting reconciliation: ${message}`);
  }
}

async function invokeWithCompletionEffect(
  descriptor: GatewayToolDescriptor,
  executor: GatewayToolExecutor,
  claims: ToolTokenClaims,
  canonicalName: string,
  args: Record<string, unknown>,
  context: GatewayToolExecutionContext | undefined,
): Promise<unknown> {
  const effect = descriptor.completionEffect && completionEffectForCall(descriptor.completionEffect, args);
  if (!effect || finishedWorkRolloutMode() === "off") {
    return invokeRegisteredOperation(executor, claims, canonicalName, args);
  }
  const identity = sourceIdentity(claims, canonicalName, context);
  const executionKey = `${claims.runId}:${identity.sourceKey}`;
  const inFlight = inFlightCompletionExecutions.get(executionKey);
  if (inFlight) return inFlight;
  const execution = withFinishedWorkSessionLocks(claims.runId, identity.sourceKey, () =>
    invokeSerializedCompletionEffect(
      effect,
      executor,
      claims,
      canonicalName,
      args,
      identity,
    ));
  inFlightCompletionExecutions.set(executionKey, execution);
  try {
    return await execution;
  } finally {
    if (inFlightCompletionExecutions.get(executionKey) === execution) {
      inFlightCompletionExecutions.delete(executionKey);
    }
  }
}

export async function executeRegisteredGatewayTool(
  claims: ToolTokenClaims,
  name: string,
  args: Record<string, unknown>,
  options?: GatewayToolListOptions,
  context?: GatewayToolExecutionContext,
): Promise<GatewayToolExecution> {
  const canonicalName = TOOL_ALIASES.get(name) ?? name;
  const resolvedOptions = options ?? (await gatewayToolListOptionsFor(claims));
  if (isGatewayMetaToolName(canonicalName)) {
    const availableTools = availableGatewayToolDescriptors(resolvedOptions);
    return {
      matched: true,
      result: await executeGatewayMetaTool(
        canonicalName,
        args,
        availableTools,
        async (toolName, toolArgs) => {
          const resolvedToolName = TOOL_ALIASES.get(toolName) ?? toolName;
          const executor = ALL_OPERATIONS.get(resolvedToolName);
          if (!executor) {
            return {
              content: [{ type: "text", text: `Unknown gateway tool: ${toolName}` }],
              isError: true,
            };
          }
          const descriptor = advertisedGatewayToolDescriptor(resolvedToolName);
          if (!descriptor) {
            return {
              content: [{ type: "text", text: `Unknown gateway tool: ${toolName}` }],
              isError: true,
            };
          }
          return invokeWithCompletionEffect(
            descriptor,
            executor,
            claims,
            resolvedToolName,
            toolArgs,
            context
              ? { requestId: JSON.stringify([context.requestId, "gateway_tool_call", resolvedToolName]) }
              : undefined,
          );
        },
      ),
    };
  }
  if (CHILD_SESSION_TOOL_NAMES.has(canonicalName) && !(await childSessionToolsEnabled(claims))) {
    return {
      matched: true,
      result: {
        content: [
          { type: "text", text: "Child sessions are not enabled for the current live run." },
        ],
        isError: true,
      },
    };
  }
  const executor = ALL_OPERATIONS.get(canonicalName);
  if (!executor) return { matched: false };
  const descriptor = advertisedGatewayToolDescriptor(canonicalName);
  if (!descriptor) return { matched: false };
  return {
    matched: true,
    result: await invokeWithCompletionEffect(
      descriptor,
      executor,
      claims,
      canonicalName,
      args,
      context,
    ),
  };
}

export { gatewayCompactToolListEnabled, isGatewayMetaToolName } from "./gateway-meta-tools";
