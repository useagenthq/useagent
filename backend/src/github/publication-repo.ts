import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { db, type Executor } from "../db/client";
import {
  githubChangeSets,
  githubPublicationReceipts,
  runs,
  type GitHubChangeManifest,
} from "../db/schema";

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_MANIFEST_FILES = 200;
const MAX_PAYLOAD_BYTES = 25 * 1024 * 1024;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_PATH_LENGTH = 4_096;
const MAX_LABEL_LENGTH = 255;
const MAX_STORAGE_KEY_LENGTH = 1_024;
const MAX_IDEMPOTENCY_KEY_LENGTH = 512;
const MAX_ERROR_LENGTH = 500;
const PUBLICATION_CLAIM_MS = 30_000;
export const GITHUB_CHANGE_SET_MAX_TTL_MS = 24 * 60 * 60 * 1_000;

export type GitHubChangeSetRecord = typeof githubChangeSets.$inferSelect;
export type GitHubPublicationReceiptRecord = typeof githubPublicationReceipts.$inferSelect;

export interface ClaimedGitHubPublicationReceipt {
  readonly receipt: GitHubPublicationReceiptRecord;
  readonly claimToken: string;
  readonly mode: "publish" | "reconcile";
}

export class GitHubPublicationIdempotencyConflictError extends Error {
  constructor() {
    super("github publication idempotency key was reused for a different request");
    this.name = "GitHubPublicationIdempotencyConflictError";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function boundedText(value: string, name: string, maxLength: number): string {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > maxLength ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new Error(`${name} is invalid`);
  }
  return normalized;
}

function sha(value: string, name: string, allowedLengths: readonly number[] = [64]): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]+$/u.test(normalized) || !allowedLengths.includes(normalized.length)) {
    throw new Error(`${name} is invalid`);
  }
  return normalized;
}

function validateManifest(input: GitHubChangeManifest): {
  manifest: GitHubChangeManifest;
  serialized: string;
  sizeBytes: number;
} {
  if (input.version !== 1 || !Array.isArray(input.files)) {
    throw new Error("github change manifest is invalid");
  }
  if (input.files.length < 1 || input.files.length > MAX_MANIFEST_FILES) {
    throw new Error(`github change manifest must contain 1-${MAX_MANIFEST_FILES} files`);
  }
  const seen = new Set<string>();
  let totalFileBytes = 0;
  const files = input.files.map((file) => {
    const path = boundedText(file.path, "github change path", MAX_PATH_LENGTH);
    if (path.startsWith("/") || path.includes("\\") || path.split("/").includes("..")) {
      throw new Error("github change path must be repository-relative");
    }
    if (seen.has(path)) throw new Error(`github change manifest repeats ${path}`);
    seen.add(path);
    if (!["add", "modify", "delete", "rename"].includes(file.action)) {
      throw new Error("github change action is invalid");
    }
    const previousPath = file.previousPath
      ? boundedText(file.previousPath, "github previous path", MAX_PATH_LENGTH)
      : undefined;
    if (
      previousPath &&
      (previousPath.startsWith("/") ||
        previousPath.includes("\\") ||
        previousPath.split("/").includes(".."))
    ) {
      throw new Error("github previous path must be repository-relative");
    }
    if (file.action === "rename" && !previousPath) {
      throw new Error("renamed github changes require previousPath");
    }
    if (
      file.sizeBytes !== undefined &&
      (!Number.isSafeInteger(file.sizeBytes) ||
        file.sizeBytes < 0 ||
        file.sizeBytes > MAX_FILE_BYTES)
    ) {
      throw new Error("github change sizeBytes is invalid");
    }
    if (file.action !== "delete" && !file.sha256) {
      throw new Error("non-delete github changes require sha256");
    }
    if (file.action !== "delete" && file.sizeBytes === undefined) {
      throw new Error("non-delete github changes require sizeBytes");
    }
    if (
      file.mode !== undefined &&
      file.mode !== "100644" &&
      file.mode !== "100755" &&
      file.mode !== "120000"
    ) {
      throw new Error("github change mode is invalid");
    }
    if (file.action !== "delete" && file.mode === undefined) {
      throw new Error("non-delete github changes require a valid mode");
    }
    totalFileBytes += file.sizeBytes ?? 0;
    if (totalFileBytes > MAX_PAYLOAD_BYTES) {
      throw new Error("github change manifest exceeds the total file-size limit");
    }
    return {
      path,
      action: file.action,
      ...(file.sha256 ? { sha256: sha(file.sha256, "github change sha256") } : {}),
      ...(file.sizeBytes !== undefined ? { sizeBytes: file.sizeBytes } : {}),
      ...(file.mode ? { mode: file.mode } : {}),
      ...(previousPath ? { previousPath } : {}),
    };
  });
  const manifest: GitHubChangeManifest = {
    version: 1,
    files,
    ...(input.title
      ? { title: boundedText(input.title, "github change title", MAX_LABEL_LENGTH) }
      : {}),
    ...(input.summary
      ? { summary: boundedText(input.summary, "github change summary", 2_000) }
      : {}),
  };
  const serialized = stableJson(manifest);
  const sizeBytes = Buffer.byteLength(serialized);
  if (sizeBytes > MAX_MANIFEST_BYTES) throw new Error("github change manifest is too large");
  return { manifest, serialized, sizeBytes };
}

function publicationRequestFingerprint(input: {
  readonly changeSetFingerprint: string;
  readonly targetBranch: string;
  readonly headBranch: string;
  readonly draft: boolean;
  readonly commitMessage: string;
  readonly pullRequestTitle: string;
  readonly pullRequestBody: string;
}): string {
  return sha256(stableJson(input));
}

type RunRepositoryBinding = Pick<
  typeof runs.$inferSelect,
  "resolvedResources"
>;

export function assertRunRepositoryBinding(
  run: RunRepositoryBinding,
  repoFullName: string,
): void {
  const bound = new Set<string>();
  for (const resource of run.resolvedResources) {
    if (
      resource.locator.type === "github.repository" ||
      resource.locator.type === "github.pull_request"
    ) {
      bound.add(resource.locator.repository.toLowerCase());
    }
  }
  if (!bound.has(repoFullName.toLowerCase())) {
    throw new Error("repoFullName is not bound to this run");
  }
}

export function assertChangeSetExpiry(expiresAt: Date, now = Date.now()): void {
  const expiry = expiresAt instanceof Date ? expiresAt.getTime() : Number.NaN;
  if (
    !Number.isFinite(expiry) ||
    expiry <= now ||
    expiry > now + GITHUB_CHANGE_SET_MAX_TTL_MS
  ) {
    throw new Error("expiresAt must be within the server change-set TTL");
  }
}

export function assertPublicationRequestMatches(
  existing: Pick<GitHubPublicationReceiptRecord, "requestFingerprint">,
  requestFingerprint: string,
): void {
  if (existing.requestFingerprint !== requestFingerprint) {
    throw new GitHubPublicationIdempotencyConflictError();
  }
}

export async function freezeGitHubChangeSet(
  input: {
    readonly orgId: string;
    readonly userId: string | null;
    readonly runId: string;
    readonly repoFullName: string;
    readonly baseRef: string;
    readonly baseSha: string;
    readonly manifest: GitHubChangeManifest;
    readonly payloadStorageKey: string;
    readonly payloadSha256: string;
    readonly payloadSizeBytes: number;
    readonly expiresAt: Date;
  },
  exec: Executor = db,
): Promise<{ row: GitHubChangeSetRecord; created: boolean }> {
  const orgId = boundedText(input.orgId, "orgId", MAX_LABEL_LENGTH);
  const [run] = await exec
    .select({
      id: runs.id,
      threadId: runs.threadId,
      projectId: runs.projectId,
      resolvedResources: runs.resolvedResources,
    })
    .from(runs)
    .where(and(eq(runs.id, input.runId), eq(runs.orgId, orgId)))
    .limit(1);
  if (!run) throw new Error("run not found for github change set");
  const repoFullName = boundedText(input.repoFullName, "repoFullName", MAX_LABEL_LENGTH);
  if (!/^[^/\s]+\/[^/\s]+$/u.test(repoFullName)) throw new Error("repoFullName is invalid");
  assertRunRepositoryBinding(run, repoFullName);
  const baseRef = boundedText(input.baseRef, "baseRef", MAX_LABEL_LENGTH);
  const baseSha = sha(input.baseSha, "baseSha", [40, 64]);
  const payloadStorageKey = boundedText(
    input.payloadStorageKey,
    "payloadStorageKey",
    MAX_STORAGE_KEY_LENGTH,
  );
  const payloadSha256 = sha(input.payloadSha256, "payloadSha256");
  if (
    !Number.isSafeInteger(input.payloadSizeBytes) ||
    input.payloadSizeBytes < 0 ||
    input.payloadSizeBytes > MAX_PAYLOAD_BYTES
  ) {
    throw new Error("payloadSizeBytes is invalid");
  }
  assertChangeSetExpiry(input.expiresAt);
  const { manifest, serialized, sizeBytes: manifestSizeBytes } = validateManifest(input.manifest);
  const fingerprint = sha256(
    stableJson({
      repoFullName,
      runId: run.id,
      baseRef,
      baseSha,
      manifest: JSON.parse(serialized),
      payloadSha256,
      payloadSizeBytes: input.payloadSizeBytes,
      expiresAt: input.expiresAt.toISOString(),
    }),
  );

  const [inserted] = await exec
    .insert(githubChangeSets)
    .values({
      orgId,
      userId: input.userId,
      runId: run.id,
      threadId: run.threadId,
      projectId: run.projectId,
      repoFullName,
      baseRef,
      baseSha,
      manifest,
      manifestSizeBytes,
      payloadStorageKey,
      payloadSha256,
      payloadSizeBytes: input.payloadSizeBytes,
      fingerprint,
      expiresAt: input.expiresAt,
    })
    .onConflictDoNothing({
      target: [githubChangeSets.orgId, githubChangeSets.fingerprint],
    })
    .returning();
  if (inserted) return { row: inserted, created: true };

  const [existing] = await exec
    .select()
    .from(githubChangeSets)
    .where(and(eq(githubChangeSets.orgId, orgId), eq(githubChangeSets.fingerprint, fingerprint)))
    .limit(1);
  if (!existing) throw new Error("github change set idempotency conflict could not be resolved");
  return { row: existing, created: false };
}

export async function getGitHubChangeSetForOrg(
  orgId: string,
  changeSetId: string,
  exec: Executor = db,
): Promise<GitHubChangeSetRecord | null> {
  const [row] = await exec
    .select()
    .from(githubChangeSets)
    .where(and(eq(githubChangeSets.orgId, orgId), eq(githubChangeSets.id, changeSetId)))
    .limit(1);
  return row ?? null;
}

export async function getGitHubPublicationReceiptForChangeSet(
  orgId: string,
  changeSetId: string,
  exec: Executor = db,
): Promise<GitHubPublicationReceiptRecord | null> {
  const [row] = await exec
    .select()
    .from(githubPublicationReceipts)
    .where(
      and(
        eq(githubPublicationReceipts.orgId, orgId),
        eq(githubPublicationReceipts.changeSetId, changeSetId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function ensureGitHubPublicationReceipt(
  input: {
    readonly orgId: string;
    readonly changeSetId: string;
    readonly idempotencyKey: string;
    readonly targetBranch: string;
    readonly headBranch: string;
    readonly draft?: boolean;
    readonly commitMessage: string;
    readonly pullRequestTitle: string;
    readonly pullRequestBody: string;
  },
  exec: Executor = db,
): Promise<{ row: GitHubPublicationReceiptRecord; created: boolean }> {
  const changeSet = await getGitHubChangeSetForOrg(input.orgId, input.changeSetId, exec);
  if (!changeSet) throw new Error("github change set not found");
  const idempotencyKey = boundedText(
    input.idempotencyKey,
    "idempotencyKey",
    MAX_IDEMPOTENCY_KEY_LENGTH,
  );
  const idempotencyKeyHash = sha256(idempotencyKey);
  const targetBranch = boundedText(input.targetBranch, "targetBranch", MAX_LABEL_LENGTH);
  const headBranch = boundedText(input.headBranch, "headBranch", MAX_LABEL_LENGTH);
  const draft = input.draft ?? false;
  const commitMessage = boundedText(input.commitMessage, "commitMessage", MAX_LABEL_LENGTH);
  const pullRequestTitle = boundedText(
    input.pullRequestTitle,
    "pullRequestTitle",
    MAX_LABEL_LENGTH,
  );
  const pullRequestBody = boundedText(input.pullRequestBody, "pullRequestBody", 64 * 1024);
  const requestFingerprint = publicationRequestFingerprint({
    changeSetFingerprint: changeSet.fingerprint,
    targetBranch,
    headBranch,
    draft,
    commitMessage,
    pullRequestTitle,
    pullRequestBody,
  });
  const [inserted] = await exec
    .insert(githubPublicationReceipts)
    .values({
      orgId: input.orgId,
      changeSetId: changeSet.id,
      idempotencyKeyHash,
      requestFingerprint,
      targetBranch,
      headBranch,
      draft,
      commitMessage,
      pullRequestTitle,
      pullRequestBody,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted) return { row: inserted, created: true };

  const [existing] = await exec
    .select()
    .from(githubPublicationReceipts)
    .where(
      and(
        eq(githubPublicationReceipts.orgId, input.orgId),
        eq(githubPublicationReceipts.idempotencyKeyHash, idempotencyKeyHash),
        eq(githubPublicationReceipts.changeSetId, changeSet.id),
      ),
    )
    .limit(1);
  if (!existing) throw new GitHubPublicationIdempotencyConflictError();
  assertPublicationRequestMatches(existing, requestFingerprint);
  return { row: existing, created: false };
}

export async function claimGitHubPublicationReceipt(
  orgId: string,
  receiptId: string,
): Promise<ClaimedGitHubPublicationReceipt | null> {
  return db.transaction(async (tx) => {
    const now = new Date();
    const claimToken = randomUUID();
    const claimExpiresAt = new Date(now.getTime() + PUBLICATION_CLAIM_MS);
    const [receipt] = await tx
      .update(githubPublicationReceipts)
      .set({
        state: "publishing",
        attemptCount: sql`${githubPublicationReceipts.attemptCount} + 1`,
        startedAt: now,
        completedAt: null,
        lastError: null,
        claimToken,
        claimExpiresAt,
        updatedAt: now,
      })
      .where(
        and(
          eq(githubPublicationReceipts.orgId, orgId),
          eq(githubPublicationReceipts.id, receiptId),
          inArray(githubPublicationReceipts.state, ["pending", "failed"]),
          sql`${githubPublicationReceipts.attemptCount} < 100`,
          sql`exists (
            select 1 from ${githubChangeSets}
            where ${githubChangeSets.id} = ${githubPublicationReceipts.changeSetId}
              and ${githubChangeSets.orgId} = ${orgId}
              and ${githubChangeSets.state} = 'frozen'
              and ${githubChangeSets.expiresAt} > now()
          )`,
        ),
      )
      .returning();
    if (!receipt) return null;
    await tx
      .update(githubChangeSets)
      .set({ state: "publishing", updatedAt: now })
      .where(
        and(eq(githubChangeSets.orgId, orgId), eq(githubChangeSets.id, receipt.changeSetId)),
      );
    return { receipt, claimToken, mode: "publish" as const };
  });
}

/** Claim an unresolved external outcome. An expired publishing lease is
 * ambiguous, never safe to republish blindly, so it enters the same
 * reconciliation lane as an explicitly unknown response. */
export async function claimGitHubPublicationReconciliation(
  orgId: string,
  receiptId: string,
): Promise<ClaimedGitHubPublicationReceipt | null> {
  return db.transaction(async (tx) => {
    const now = new Date();
    const claimToken = randomUUID();
    const claimExpiresAt = new Date(now.getTime() + PUBLICATION_CLAIM_MS);
    const [receipt] = await tx
      .update(githubPublicationReceipts)
      .set({ state: "reconcile_required", claimToken, claimExpiresAt, updatedAt: now })
      .where(
        and(
          eq(githubPublicationReceipts.orgId, orgId),
          eq(githubPublicationReceipts.id, receiptId),
          or(
            and(
              eq(githubPublicationReceipts.state, "reconcile_required"),
              or(
                isNull(githubPublicationReceipts.claimToken),
                lte(githubPublicationReceipts.claimExpiresAt, now),
              ),
            ),
            and(
              eq(githubPublicationReceipts.state, "publishing"),
              lte(githubPublicationReceipts.claimExpiresAt, now),
            ),
          ),
        ),
      )
      .returning();
    if (!receipt) return null;
    await tx
      .update(githubChangeSets)
      .set({ state: "reconcile_required", updatedAt: now })
      .where(
        and(eq(githubChangeSets.orgId, orgId), eq(githubChangeSets.id, receipt.changeSetId)),
      );
    return { receipt, claimToken, mode: "reconcile" as const };
  });
}

/** Renew a fenced publication/reconciliation lease. The token changes whenever
 * an expired lease is reclaimed, so a stale worker cannot renew or perform the
 * next external operation after another worker has taken ownership. */
export async function renewGitHubPublicationClaim(input: {
  readonly orgId: string;
  readonly receiptId: string;
  readonly claimToken: string;
}): Promise<boolean> {
  const now = new Date();
  const [row] = await db
    .update(githubPublicationReceipts)
    .set({
      claimExpiresAt: new Date(now.getTime() + PUBLICATION_CLAIM_MS),
      updatedAt: now,
    })
    .where(
      and(
        eq(githubPublicationReceipts.orgId, input.orgId),
        eq(githubPublicationReceipts.id, input.receiptId),
        inArray(githubPublicationReceipts.state, ["publishing", "reconcile_required"]),
        eq(githubPublicationReceipts.claimToken, input.claimToken),
      ),
    )
    .returning({ id: githubPublicationReceipts.id });
  return row !== undefined;
}

/** Persist the deterministic commit we intend to expose before attempting to
 * create its branch. Reconciliation must never infer intent from a live ref. */
export async function recordGitHubPublicationIntent(input: {
  readonly orgId: string;
  readonly receiptId: string;
  readonly claimToken: string;
  readonly commitSha: string;
}): Promise<boolean> {
  const commitSha = sha(input.commitSha, "commitSha", [40, 64]);
  const [row] = await db
    .update(githubPublicationReceipts)
    .set({ commitSha, updatedAt: new Date() })
    .where(
      and(
        eq(githubPublicationReceipts.orgId, input.orgId),
        eq(githubPublicationReceipts.id, input.receiptId),
        eq(githubPublicationReceipts.state, "publishing"),
        eq(githubPublicationReceipts.claimToken, input.claimToken),
        or(
          isNull(githubPublicationReceipts.commitSha),
          eq(githubPublicationReceipts.commitSha, commitSha),
        ),
      ),
    )
    .returning({ id: githubPublicationReceipts.id });
  return row !== undefined;
}

export async function recordGitHubPublicationSuccess(input: {
  readonly orgId: string;
  readonly receiptId: string;
  readonly claimToken: string;
  readonly commitSha: string;
  readonly pullRequestNumber?: number | null;
  readonly pullRequestUrl?: string | null;
}): Promise<GitHubPublicationReceiptRecord | null> {
  const commitSha = sha(input.commitSha, "commitSha", [40, 64]);
  if (
    input.pullRequestNumber !== undefined &&
    input.pullRequestNumber !== null &&
    (!Number.isSafeInteger(input.pullRequestNumber) || input.pullRequestNumber < 1)
  ) {
    throw new Error("pullRequestNumber is invalid");
  }
  const pullRequestUrl = input.pullRequestUrl
    ? boundedText(input.pullRequestUrl, "pullRequestUrl", 2_048)
    : null;
  if (pullRequestUrl) {
    const parsed = new URL(pullRequestUrl);
    if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") {
      throw new Error("pullRequestUrl is invalid");
    }
  }
  return db.transaction(async (tx) => {
    const now = new Date();
    const [receipt] = await tx
      .update(githubPublicationReceipts)
      .set({
        state: "published",
        commitSha,
        pullRequestNumber: input.pullRequestNumber ?? null,
        pullRequestUrl,
        lastError: null,
        claimToken: null,
        claimExpiresAt: null,
        completedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(githubPublicationReceipts.orgId, input.orgId),
          eq(githubPublicationReceipts.id, input.receiptId),
          inArray(githubPublicationReceipts.state, ["publishing", "reconcile_required"]),
          eq(githubPublicationReceipts.claimToken, input.claimToken),
          eq(githubPublicationReceipts.commitSha, commitSha),
        ),
      )
      .returning();
    if (!receipt) return null;
    await tx
      .update(githubChangeSets)
      .set({ state: "published", publishedAt: now, updatedAt: now })
      .where(
        and(
          eq(githubChangeSets.orgId, input.orgId),
          eq(githubChangeSets.id, receipt.changeSetId),
        ),
      );
    return receipt;
  });
}

export async function recordGitHubPublicationFailure(input: {
  readonly orgId: string;
  readonly receiptId: string;
  readonly claimToken: string;
  readonly error: string;
}): Promise<GitHubPublicationReceiptRecord | null> {
  const error = input.error.trim().slice(0, MAX_ERROR_LENGTH) || "github publication failed";
  return db.transaction(async (tx) => {
    const now = new Date();
    const [receipt] = await tx
      .update(githubPublicationReceipts)
      .set({
        state: "failed",
        lastError: error,
        claimToken: null,
        claimExpiresAt: null,
        completedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(githubPublicationReceipts.orgId, input.orgId),
          eq(githubPublicationReceipts.id, input.receiptId),
          eq(githubPublicationReceipts.state, "publishing"),
          eq(githubPublicationReceipts.claimToken, input.claimToken),
        ),
      )
      .returning();
    if (!receipt) return null;
    await tx
      .update(githubChangeSets)
      .set({ state: "frozen", updatedAt: now })
      .where(
        and(
          eq(githubChangeSets.orgId, input.orgId),
          eq(githubChangeSets.id, receipt.changeSetId),
        ),
      );
    return receipt;
  });
}

/** Abort an attempt that is provably before head-ref creation. The claim token
 * fences stale workers; clearing commitSha is required because a later GitHub
 * commit object may receive a different server-generated identity on retry. */
export async function recordGitHubPublicationPreRefAbort(input: {
  readonly orgId: string;
  readonly receiptId: string;
  readonly claimToken: string;
  readonly error?: string | null;
}): Promise<GitHubPublicationReceiptRecord | null> {
  const error = input.error?.trim().slice(0, MAX_ERROR_LENGTH) || null;
  return db.transaction(async (tx) => {
    const now = new Date();
    const [receipt] = await tx
      .update(githubPublicationReceipts)
      .set({
        state: "pending",
        commitSha: null,
        pullRequestNumber: null,
        pullRequestUrl: null,
        lastError: error,
        claimToken: null,
        claimExpiresAt: null,
        completedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(githubPublicationReceipts.orgId, input.orgId),
          eq(githubPublicationReceipts.id, input.receiptId),
          inArray(githubPublicationReceipts.state, ["publishing", "reconcile_required"]),
          eq(githubPublicationReceipts.claimToken, input.claimToken),
        ),
      )
      .returning();
    if (!receipt) return null;
    await tx
      .update(githubChangeSets)
      .set({ state: "frozen", updatedAt: now })
      .where(
        and(
          eq(githubChangeSets.orgId, input.orgId),
          eq(githubChangeSets.id, receipt.changeSetId),
        ),
      );
    return receipt;
  });
}

export async function recordGitHubPublicationAmbiguous(input: {
  readonly orgId: string;
  readonly receiptId: string;
  readonly claimToken: string;
  readonly error: string;
  readonly commitSha?: string | null;
}): Promise<GitHubPublicationReceiptRecord | null> {
  const error =
    input.error.trim().slice(0, MAX_ERROR_LENGTH) || "github publication outcome is unknown";
  const commitSha = input.commitSha ? sha(input.commitSha, "commitSha", [40, 64]) : null;
  return db.transaction(async (tx) => {
    const now = new Date();
    const [receipt] = await tx
      .update(githubPublicationReceipts)
      .set({
        state: "reconcile_required",
        ...(commitSha ? { commitSha } : {}),
        lastError: error,
        claimToken: null,
        claimExpiresAt: null,
        completedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(githubPublicationReceipts.orgId, input.orgId),
          eq(githubPublicationReceipts.id, input.receiptId),
          inArray(githubPublicationReceipts.state, ["publishing", "reconcile_required"]),
          eq(githubPublicationReceipts.claimToken, input.claimToken),
          commitSha
            ? or(
                isNull(githubPublicationReceipts.commitSha),
                eq(githubPublicationReceipts.commitSha, commitSha),
              )
            : undefined,
        ),
      )
      .returning();
    if (!receipt) return null;
    await tx
      .update(githubChangeSets)
      .set({ state: "reconcile_required", updatedAt: now })
      .where(
        and(
          eq(githubChangeSets.orgId, input.orgId),
          eq(githubChangeSets.id, receipt.changeSetId),
        ),
      );
    return receipt;
  });
}

/** Only a deterministic lookup proving that no branch/commit/PR exists may
 * return an ambiguous publication to the publishable frozen state. */
export async function recordGitHubPublicationAbsentAfterReconcile(input: {
  readonly orgId: string;
  readonly receiptId: string;
  readonly claimToken: string;
}): Promise<GitHubPublicationReceiptRecord | null> {
  return db.transaction(async (tx) => {
    const now = new Date();
    const [receipt] = await tx
      .update(githubPublicationReceipts)
      .set({
        state: "pending",
        commitSha: null,
        pullRequestNumber: null,
        pullRequestUrl: null,
        lastError: null,
        claimToken: null,
        claimExpiresAt: null,
        completedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(githubPublicationReceipts.orgId, input.orgId),
          eq(githubPublicationReceipts.id, input.receiptId),
          eq(githubPublicationReceipts.state, "reconcile_required"),
          eq(githubPublicationReceipts.claimToken, input.claimToken),
        ),
      )
      .returning();
    if (!receipt) return null;
    await tx
      .update(githubChangeSets)
      .set({ state: "frozen", updatedAt: now })
      .where(
        and(
          eq(githubChangeSets.orgId, input.orgId),
          eq(githubChangeSets.id, receipt.changeSetId),
        ),
      );
    return receipt;
  });
}
