import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { db, type Executor } from "../db/client";
import {
  githubChangeSets,
  githubPublicationReceipts,
  runs,
  type GitHubChangeManifest,
} from "../db/schema";
import {
  assertChangeSetExpiry,
  assertPublicationRequestMatches,
  assertRunRepositoryBinding,
  boundedText,
  GitHubPublicationIdempotencyConflictError,
  MAX_ERROR_LENGTH,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_LABEL_LENGTH,
  MAX_PAYLOAD_BYTES,
  MAX_STORAGE_KEY_LENGTH,
  publicationRequestFingerprint,
  sha,
  sha256,
  stableJson,
  validateManifest,
} from "./publication-repo-input.js";

const PUBLICATION_CLAIM_MS = 30_000;
export {
  assertChangeSetExpiry,
  assertPublicationRequestMatches,
  assertRunRepositoryBinding,
  GITHUB_CHANGE_SET_MAX_TTL_MS,
  GitHubPublicationIdempotencyConflictError,
} from "./publication-repo-input.js";

export type GitHubChangeSetRecord = typeof githubChangeSets.$inferSelect;
export type GitHubPublicationReceiptRecord = typeof githubPublicationReceipts.$inferSelect;

export interface ClaimedGitHubPublicationReceipt {
  readonly receipt: GitHubPublicationReceiptRecord;
  readonly claimToken: string;
  readonly mode: "publish" | "reconcile";
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
