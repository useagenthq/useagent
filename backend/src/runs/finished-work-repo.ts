import { and, eq } from "drizzle-orm";
import { db, type Executor } from "../db/client";
import {
  artifacts,
  finishedWorkObligations,
  finishedWorkReceipts,
  runs,
  type FinishedWorkObligationState,
  type FinishedWorkObligationAuthority,
  type FinishedWorkReceiptAuthority,
  type FinishedWorkReceiptKind,
  type FinishedWorkReceiptMetadata,
  type FinishedWorkRequirement,
  type FinishedWorkSourceKind,
} from "../db/schema";
import { withFinishedWorkRunLock } from "./finished-work-lock";

const MAX_SOURCE_KEY = 256;
const MAX_PROVIDER = 64;
const MAX_CANDIDATE_NAME = 255;
const MAX_METADATA_BYTES = 8 * 1024;
const STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/u;
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const FAILURE_CODE = /^[a-z][a-z0-9_.-]*$/u;
const GITHUB_PULL_REQUEST_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)$/u;
const SAFE_METADATA_KEYS = new Set([
  "count",
  "itemCount",
  "byteCount",
  "digest",
  "mime",
  "provider",
  "action",
  "commitSha",
  "pullRequestUrl",
]);

export class FinishedWorkIdempotencyConflictError extends Error {
  constructor() {
    super("finished work idempotency key reused with different content");
    this.name = "FinishedWorkIdempotencyConflictError";
  }
}

export type FinishedWorkObligationRecord = typeof finishedWorkObligations.$inferSelect;
export type FinishedWorkReceiptRecord = typeof finishedWorkReceipts.$inferSelect;

function boundedStableId(value: string, field: string, max = MAX_SOURCE_KEY): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max || !STABLE_ID.test(normalized)) {
    throw new Error(`${field} must be a bounded opaque identifier`);
  }
  return normalized;
}

function optionalStableId(value: string | null | undefined, field: string): string | null {
  return value == null ? null : boundedStableId(value, field);
}

function optionalProvider(value: string | null | undefined): string | null {
  if (value == null) return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_PROVIDER || !PROVIDER_ID.test(normalized)) {
    throw new Error("sourceProvider must be a bounded provider identifier");
  }
  return normalized;
}

function optionalCandidateName(value: string | null | undefined): string | null {
  if (value == null) return null;
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > MAX_CANDIDATE_NAME ||
    /[\/\\\u0000-\u001f\u007f]/u.test(normalized) ||
    /^[a-z][a-z0-9+.-]*:\/\//iu.test(normalized)
  ) {
    throw new Error("candidateName must be a safe display name, not a path or URL");
  }
  return normalized;
}

function optionalFailureCode(value: string | null | undefined): string | null {
  if (value == null) return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > 64 || !FAILURE_CODE.test(normalized)) {
    throw new Error("failureCode must be a bounded machine code");
  }
  return normalized;
}

function safeMetadata(input: FinishedWorkReceiptMetadata | undefined): FinishedWorkReceiptMetadata {
  const metadata = input ?? {};
  for (const key of Object.keys(metadata)) {
    if (!SAFE_METADATA_KEYS.has(key)) throw new Error(`finished work metadata key is not allowed: ${key}`);
  }
  for (const key of ["count", "itemCount", "byteCount"] as const) {
    const value = metadata[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error(`finished work metadata ${key} is invalid`);
    }
  }
  for (const [key, value] of Object.entries(metadata)) {
    if (key === "count" || key === "itemCount" || key === "byteCount" || value === undefined) continue;
    if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
      throw new Error(`finished work metadata ${key} is invalid`);
    }
  }
  if (metadata.digest !== undefined && !/^[0-9a-f]{64}$/iu.test(metadata.digest)) {
    throw new Error("finished work metadata digest is invalid");
  }
  if (
    metadata.mime !== undefined &&
    !/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,62}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,62}$/u.test(metadata.mime)
  ) {
    throw new Error("finished work metadata mime is invalid");
  }
  for (const key of ["provider", "action"] as const) {
    const value = metadata[key];
    if (value !== undefined && (value.length > 64 || !PROVIDER_ID.test(value))) {
      throw new Error(`finished work metadata ${key} is invalid`);
    }
  }
  if (metadata.commitSha !== undefined && !/^[0-9a-f]{40}([0-9a-f]{24})?$/iu.test(metadata.commitSha)) {
    throw new Error("finished work metadata commitSha is invalid");
  }
  if (metadata.pullRequestUrl !== undefined) {
    let decoded: string;
    let parsed: URL;
    try {
      decoded = decodeURIComponent(metadata.pullRequestUrl);
      parsed = new URL(decoded);
    } catch {
      throw new Error("finished work metadata pullRequestUrl is invalid");
    }
    const match = GITHUB_PULL_REQUEST_URL.exec(decoded);
    const owner = match?.[1];
    const repo = match?.[2];
    const pullNumber = match?.[3];
    const canonical = owner && repo && pullNumber
      ? `https://github.com/${owner}/${repo}/pull/${pullNumber}`
      : null;
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== "github.com" ||
      parsed.port ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      decoded !== metadata.pullRequestUrl ||
      owner === "." ||
      owner === ".." ||
      repo === "." ||
      repo === ".." ||
      metadata.pullRequestUrl !== canonical
    ) {
      throw new Error("finished work metadata pullRequestUrl is invalid");
    }
  }
  if (Buffer.byteLength(JSON.stringify(metadata), "utf8") > MAX_METADATA_BYTES) {
    throw new Error("finished work metadata exceeds 8 KiB");
  }
  return metadata;
}

async function requireRunBinding(
  orgId: string,
  runId: string,
  exec: Executor,
): Promise<{ id: string; threadId: string; status: string }> {
  const [run] = await exec
    .select({ id: runs.id, threadId: runs.threadId, status: runs.status })
    .from(runs)
    .where(and(eq(runs.id, runId), eq(runs.orgId, orgId)))
    .limit(1);
  if (!run) throw new Error("run not found for finished work");
  return run;
}

async function requireArtifactBinding(
  orgId: string,
  threadId: string,
  artifactId: string | null,
  exec: Executor,
): Promise<{ runId: string; workpieceRevision: number } | null> {
  if (!artifactId) return null;
  const [artifact] = await exec
    .select({ id: artifacts.id, runId: artifacts.runId, workpieceRevision: artifacts.workpieceRevision })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.id, artifactId),
        eq(artifacts.orgId, orgId),
        eq(artifacts.threadId, threadId),
      ),
    )
    .limit(1);
  if (!artifact) throw new Error("artifact not found for finished work scope");
  return artifact;
}

function obligationMatches(
  row: FinishedWorkObligationRecord,
  expected: Omit<FinishedWorkObligationRecord, "id" | "openedAt" | "updatedAt" | "resolvedAt">,
): boolean {
  return row.orgId === expected.orgId && row.runId === expected.runId &&
    row.threadId === expected.threadId && row.sourceKind === expected.sourceKind &&
    row.authority === expected.authority && row.sourceKey === expected.sourceKey &&
    row.requirement === expected.requirement &&
    row.sourceProvider === expected.sourceProvider &&
    row.sourceCallId === expected.sourceCallId && row.candidateName === expected.candidateName &&
    row.targetArtifactId === expected.targetArtifactId &&
    row.materializedArtifactId === expected.materializedArtifactId &&
    row.materializedArtifactRevision === expected.materializedArtifactRevision;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function receiptMatches(
  row: FinishedWorkReceiptRecord | undefined,
  expected: Omit<FinishedWorkReceiptRecord, "id" | "createdAt">,
): row is FinishedWorkReceiptRecord {
  return row !== undefined && row.orgId === expected.orgId && row.runId === expected.runId &&
    row.threadId === expected.threadId && row.obligationId === expected.obligationId &&
    row.kind === expected.kind && row.authority === expected.authority &&
    row.sourceKey === expected.sourceKey && row.artifactId === expected.artifactId &&
    row.artifactRevision === expected.artifactRevision && row.externalRef === expected.externalRef &&
    stableJson(row.metadata) === stableJson(expected.metadata);
}

function runIsTerminal(status: string): boolean {
  return status === "completed" || status === "failed";
}

export async function openFinishedWorkObligation(
  input: {
    readonly orgId: string;
    readonly runId: string;
    readonly sourceKind: FinishedWorkSourceKind;
    readonly authority: FinishedWorkObligationAuthority;
    readonly sourceKey: string;
    readonly requirement: FinishedWorkRequirement;
    readonly sourceProvider?: string | null;
    readonly sourceCallId?: string | null;
    readonly candidateName?: string | null;
    readonly targetArtifactId?: string | null;
  },
  exec: Executor = db,
): Promise<{ row: FinishedWorkObligationRecord; created: boolean }> {
  return withFinishedWorkRunLock(input.runId, exec, async (locked) => {
    const run = await requireRunBinding(input.orgId, input.runId, locked);
    const authorityMatches =
      ((input.sourceKind === "gateway_tool" || input.sourceKind === "sandbox_output") &&
        input.authority === "integration_gateway") ||
      (input.sourceKind === "provider_native" && input.authority === "provider_adapter");
    if (!authorityMatches) {
      throw new Error(`${input.sourceKind} cannot open an obligation with ${input.authority} authority`);
    }
    const sourceKey = boundedStableId(input.sourceKey, "sourceKey");
    const sourceProvider = optionalProvider(input.sourceProvider);
    const sourceCallId = optionalStableId(input.sourceCallId, "sourceCallId");
    const candidateName = optionalCandidateName(input.candidateName);
    const targetArtifactId = input.targetArtifactId ?? null;
    if (input.requirement === "artifact_update" && !targetArtifactId) {
      throw new Error("artifact_update requires targetArtifactId");
    }
    await requireArtifactBinding(input.orgId, run.threadId, targetArtifactId, locked);
    const expected = {
      orgId: input.orgId,
      runId: run.id,
      threadId: run.threadId,
      sourceKind: input.sourceKind,
      authority: input.authority,
      sourceKey,
      requirement: input.requirement,
      state: "open" as const,
      sourceProvider,
      sourceCallId,
      candidateName,
      targetArtifactId,
      materializedArtifactId: null,
      materializedArtifactRevision: null,
      failureCode: null,
    };
    if (runIsTerminal(run.status)) {
      const [existing] = await locked
        .select()
        .from(finishedWorkObligations)
        .where(and(eq(finishedWorkObligations.runId, run.id), eq(finishedWorkObligations.sourceKey, sourceKey)))
        .limit(1);
      if (existing && obligationMatches(existing, expected)) {
        return { row: existing, created: false };
      }
      throw new Error("finished work mutations are closed after run settlement");
    }
    const [inserted] = await locked
      .insert(finishedWorkObligations)
      .values(expected)
      .onConflictDoNothing({
        target: [finishedWorkObligations.runId, finishedWorkObligations.sourceKey],
      })
      .returning();
    if (inserted) return { row: inserted, created: true };
    const [existing] = await locked
      .select()
      .from(finishedWorkObligations)
      .where(and(eq(finishedWorkObligations.runId, run.id), eq(finishedWorkObligations.sourceKey, sourceKey)))
      .limit(1);
    if (!existing || !obligationMatches(existing, expected)) {
      throw new FinishedWorkIdempotencyConflictError();
    }
    return { row: existing, created: false };
  });
}

export async function recordFinishedWorkMaterialization(
  input: {
    readonly orgId: string;
    readonly runId: string;
    readonly obligationId: string;
    readonly artifactId: string;
    readonly artifactRevision: number;
  },
  exec: Executor = db,
): Promise<FinishedWorkObligationRecord> {
  return withFinishedWorkRunLock(input.runId, exec, async (locked) => {
    const run = await requireRunBinding(input.orgId, input.runId, locked);
    if (!Number.isSafeInteger(input.artifactRevision) || input.artifactRevision < 0) {
      throw new Error("artifactRevision is invalid");
    }
    const [obligation] = await locked
      .select()
      .from(finishedWorkObligations)
      .where(
        and(
          eq(finishedWorkObligations.id, input.obligationId),
          eq(finishedWorkObligations.orgId, input.orgId),
          eq(finishedWorkObligations.runId, run.id),
          eq(finishedWorkObligations.threadId, run.threadId),
        ),
      )
      .for("update")
      .limit(1);
    if (!obligation) throw new Error("finished work obligation not found in run scope");
    const artifact = await requireArtifactBinding(input.orgId, run.threadId, input.artifactId, locked);
    if (!artifact || artifact.workpieceRevision !== input.artifactRevision) {
      throw new Error("finished work materialization does not match the artifact store");
    }
    if (obligation.requirement === "artifact_create" && artifact.runId !== run.id) {
      throw new Error("artifact_create materialization must come from the current run");
    }
    if (
      obligation.requirement === "artifact_update" &&
      obligation.targetArtifactId !== input.artifactId
    ) {
      throw new Error("artifact_update materialization must reference its target artifact");
    }
    if (obligation.materializedArtifactId || obligation.materializedArtifactRevision !== null) {
      if (
        obligation.materializedArtifactId !== input.artifactId ||
        obligation.materializedArtifactRevision !== input.artifactRevision
      ) {
        throw new FinishedWorkIdempotencyConflictError();
      }
      return obligation;
    }
    if (obligation.state !== "open") {
      throw new Error(`finished work obligation is already ${obligation.state}`);
    }
    if (runIsTerminal(run.status)) {
      throw new Error("finished work mutations are closed after run settlement");
    }
    const [updated] = await locked
      .update(finishedWorkObligations)
      .set({
        materializedArtifactId: input.artifactId,
        materializedArtifactRevision: input.artifactRevision,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(finishedWorkObligations.id, obligation.id),
          eq(finishedWorkObligations.state, "open"),
        ),
      )
      .returning();
    if (!updated) throw new Error("finished work materialization lost serialization");
    return updated;
  });
}

function receiptSatisfies(requirement: FinishedWorkRequirement, kind: FinishedWorkReceiptKind): boolean {
  return (requirement === "artifact_create" && kind === "artifact_created") ||
    (requirement === "artifact_update" && kind === "artifact_updated") ||
    (requirement === "external_action" && kind === "external_action_completed");
}

function receiptAuthorityAllowed(
  kind: FinishedWorkReceiptKind,
  authority: FinishedWorkReceiptAuthority,
): boolean {
  if (kind === "artifact_created" || kind === "artifact_updated") {
    return authority === "artifact_store" || authority === "workpiece_store";
  }
  if (kind === "repository_changed") return authority === "github_publication";
  if (kind === "external_action_completed") {
    return authority === "github_publication" ||
      authority === "slack_outbox" ||
      authority === "integration_gateway";
  }
  return authority === "run_engine";
}

export async function recordFinishedWorkReceipt(
  input: {
    readonly orgId: string;
    readonly runId: string;
    readonly obligationId?: string | null;
    readonly kind: FinishedWorkReceiptKind;
    readonly authority: FinishedWorkReceiptAuthority;
    readonly sourceKey: string;
    readonly artifactId?: string | null;
    readonly artifactRevision?: number | null;
    readonly externalRef?: string | null;
    readonly metadata?: FinishedWorkReceiptMetadata;
  },
  exec: Executor = db,
): Promise<{ row: FinishedWorkReceiptRecord; created: boolean }> {
  return withFinishedWorkRunLock(input.runId, exec, async (tx) => {
    const run = await requireRunBinding(input.orgId, input.runId, tx);
    const sourceKey = boundedStableId(input.sourceKey, "sourceKey");
    const artifactId = input.artifactId ?? null;
    const artifactRevision = input.artifactRevision ?? null;
    const externalRef = optionalStableId(input.externalRef, "externalRef");
    const metadata = safeMetadata(input.metadata);
    if (!receiptAuthorityAllowed(input.kind, input.authority)) {
      throw new Error(`${input.authority} cannot issue ${input.kind}`);
    }
    if ((input.kind === "artifact_created" || input.kind === "artifact_updated") && !artifactId) {
      throw new Error(`${input.kind} requires artifactId`);
    }
    if (input.kind === "artifact_updated" && !input.obligationId) {
      throw new Error("artifact_updated requires an obligation");
    }
    if (artifactRevision !== null && (!Number.isSafeInteger(artifactRevision) || artifactRevision < 0)) {
      throw new Error("artifactRevision is invalid");
    }
    const boundArtifact = await requireArtifactBinding(input.orgId, run.threadId, artifactId, tx);
    if (input.kind === "artifact_created" && boundArtifact?.runId !== run.id) {
      throw new Error("artifact_created must reference an artifact created by the current run");
    }

    let obligation: FinishedWorkObligationRecord | null = null;
    if (input.obligationId) {
      const [found] = await tx
        .select()
        .from(finishedWorkObligations)
        .where(
          and(
            eq(finishedWorkObligations.id, input.obligationId),
            eq(finishedWorkObligations.orgId, input.orgId),
            eq(finishedWorkObligations.runId, run.id),
            eq(finishedWorkObligations.threadId, run.threadId),
          ),
        )
        .for("update")
        .limit(1);
      if (!found) throw new Error("finished work obligation not found in run scope");
      if (!receiptSatisfies(found.requirement, input.kind)) {
        throw new Error(`${input.kind} cannot satisfy ${found.requirement}`);
      }
      if (found.requirement === "artifact_update" && found.targetArtifactId !== artifactId) {
        throw new Error("artifact_updated must reference the obligation target artifact");
      }
      if (
        found.materializedArtifactId &&
        (
          found.materializedArtifactId !== artifactId ||
          found.materializedArtifactRevision !== artifactRevision
        )
      ) {
        throw new Error("finished work receipt must match the materialized artifact revision");
      }
      if (found.state === "failed" || found.state === "waived") {
        throw new Error(`finished work obligation is already ${found.state}`);
      }
      obligation = found;
    }

    const values = {
      orgId: input.orgId,
      runId: run.id,
      threadId: run.threadId,
      obligationId: obligation?.id ?? null,
      kind: input.kind,
      authority: input.authority,
      sourceKey,
      artifactId,
      artifactRevision,
      externalRef,
      metadata,
    };
    if (runIsTerminal(run.status)) {
      const [existing] = await tx
        .select()
        .from(finishedWorkReceipts)
        .where(and(eq(finishedWorkReceipts.runId, run.id), eq(finishedWorkReceipts.sourceKey, sourceKey)))
        .limit(1);
      if (receiptMatches(existing, values)) return { row: existing, created: false };
      throw new Error("finished work mutations are closed after run settlement");
    }
    const [inserted] = await tx
      .insert(finishedWorkReceipts)
      .values(values)
      .onConflictDoNothing()
      .returning();
    if (!inserted) {
      const [existing] = await tx
        .select()
        .from(finishedWorkReceipts)
        .where(and(eq(finishedWorkReceipts.runId, run.id), eq(finishedWorkReceipts.sourceKey, sourceKey)))
        .limit(1);
      if (!receiptMatches(existing, values)) throw new FinishedWorkIdempotencyConflictError();
      return { row: existing, created: false };
    }
    if (obligation && obligation.state === "open") {
      const [satisfied] = await tx
        .update(finishedWorkObligations)
        .set({ state: "satisfied", failureCode: null, resolvedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(finishedWorkObligations.id, obligation.id), eq(finishedWorkObligations.state, "open")))
        .returning({ id: finishedWorkObligations.id });
      if (!satisfied) throw new Error("finished work obligation transition lost serialization");
    }
    return { row: inserted, created: true };
  });
}

export async function resolveFinishedWorkObligation(
  input: {
    readonly orgId: string;
    readonly runId: string;
    readonly obligationId: string;
    readonly state: Extract<FinishedWorkObligationState, "failed" | "waived">;
    readonly failureCode?: string | null;
  },
  exec: Executor = db,
): Promise<FinishedWorkObligationRecord> {
  return withFinishedWorkRunLock(input.runId, exec, async (locked) => {
    const run = await requireRunBinding(input.orgId, input.runId, locked);
    const failureCode = input.state === "failed"
      ? optionalFailureCode(input.failureCode) ?? "finished_work_failed"
      : null;
    const [existing] = await locked
      .select()
      .from(finishedWorkObligations)
      .where(
        and(
          eq(finishedWorkObligations.id, input.obligationId),
          eq(finishedWorkObligations.orgId, input.orgId),
          eq(finishedWorkObligations.runId, run.id),
          eq(finishedWorkObligations.threadId, run.threadId),
        ),
      )
      .for("update")
      .limit(1);
    if (!existing) throw new Error("finished work obligation not found in run scope");
    if (existing.state !== "open") {
      if (existing.state !== input.state || existing.failureCode !== failureCode) {
        throw new FinishedWorkIdempotencyConflictError();
      }
      return existing;
    }
    if (runIsTerminal(run.status)) {
      throw new Error("finished work mutations are closed after run settlement");
    }
    const [updated] = await locked
      .update(finishedWorkObligations)
      .set({ state: input.state, failureCode, resolvedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(finishedWorkObligations.id, existing.id),
          eq(finishedWorkObligations.state, "open"),
        ),
      )
      .returning();
    if (!updated) throw new Error("finished work obligation transition lost serialization");
    return updated;
  });
}

export async function listFinishedWorkForRun(
  orgId: string,
  runId: string,
  exec: Executor = db,
): Promise<{
  obligations: FinishedWorkObligationRecord[];
  receipts: FinishedWorkReceiptRecord[];
}> {
  const run = await requireRunBinding(orgId, runId, exec);
  const obligations = await exec.select().from(finishedWorkObligations).where(
    and(eq(finishedWorkObligations.orgId, orgId), eq(finishedWorkObligations.runId, run.id)),
  );
  const receipts = await exec.select().from(finishedWorkReceipts).where(
    and(eq(finishedWorkReceipts.orgId, orgId), eq(finishedWorkReceipts.runId, run.id)),
  );
  return { obligations, receipts };
}
