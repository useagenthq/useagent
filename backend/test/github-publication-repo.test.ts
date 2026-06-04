import { afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db } from "../src/db/client";
import { githubPublicationReceipts, runs } from "../src/db/schema";
import {
  claimGitHubPublicationReceipt,
  ensureGitHubPublicationReceipt,
  freezeGitHubChangeSet,
  GitHubPublicationIdempotencyConflictError,
  recordGitHubPublicationIntent,
  recordGitHubPublicationPreRefAbort,
  renewGitHubPublicationClaim,
} from "../src/github/publication-repo";

const runId = `github-publication-${crypto.randomUUID()}`;
const orgId = `org-${crypto.randomUUID()}`;
const repository = "acme/api";

await migrate(db, { migrationsFolder: `${import.meta.dir}/../drizzle` });

afterAll(async () => {
  await db.delete(runs).where(eq(runs.id, runId));
});

describe("github publication receipt persistence", () => {
  test("rejects a second idempotency key for the same frozen change set", async () => {
    await db.insert(runs).values({
      id: runId,
      orgId,
      userId: "user-1",
      prompt: "publish",
      model: "test",
      engine: "mock",
      status: "completed",
      threadId: runId,
      resolvedResources: [
        {
          kind: "code.repository",
          provider: "github",
          locator: { type: "github.repository", repository, revision: null },
          capabilities: ["content.read", "code.checkout"],
          provenance: [
            {
              source: "explicit",
              channel: "api",
              raw: repository,
              start: null,
              end: null,
            },
          ],
        },
      ],
    });
    const { row: changeSet } = await freezeGitHubChangeSet({
      orgId,
      userId: "user-1",
      runId,
      repoFullName: repository,
      baseRef: "main",
      baseSha: "a".repeat(40),
      manifest: {
        version: 1,
        files: [{
          path: "README.md",
          action: "modify",
          sha256: "b".repeat(64),
          sizeBytes: 12,
          mode: "100644",
        }],
      },
      payloadStorageKey: `github-change-sets/${runId}`,
      payloadSha256: "c".repeat(64),
      payloadSizeBytes: 12,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const request = {
      orgId,
      changeSetId: changeSet.id,
      targetBranch: "main",
      headBranch: `useagent/${runId}`,
      commitMessage: "Update README",
      pullRequestTitle: "Update README",
      pullRequestBody: "Prepared by the agent.",
    };
    await expect(
      ensureGitHubPublicationReceipt({ ...request, idempotencyKey: "first-key" }),
    ).resolves.toMatchObject({ created: true });
    await expect(
      ensureGitHubPublicationReceipt({ ...request, idempotencyKey: "second-key" }),
    ).rejects.toBeInstanceOf(GitHubPublicationIdempotencyConflictError);
  });

  test("fences a stale publisher after another worker owns the durable lease", async () => {
    const concurrentRunId = `github-publication-fence-${crypto.randomUUID()}`;
    await db.insert(runs).values({
      id: concurrentRunId,
      orgId,
      userId: "user-1",
      prompt: "publish",
      model: "test",
      engine: "mock",
      status: "completed",
      threadId: concurrentRunId,
      resolvedResources: [{
        kind: "code.repository",
        provider: "github",
        locator: { type: "github.repository", repository, revision: null },
        capabilities: ["content.read", "code.checkout"],
        provenance: [{
          source: "explicit",
          channel: "api",
          raw: repository,
          start: null,
          end: null,
        }],
      }],
    });
    try {
      const { row: changeSet } = await freezeGitHubChangeSet({
        orgId,
        userId: "user-1",
        runId: concurrentRunId,
        repoFullName: repository,
        baseRef: "main",
        baseSha: "a".repeat(40),
        manifest: {
          version: 1,
          files: [{
            path: "README.md",
            action: "modify",
            sha256: "b".repeat(64),
            sizeBytes: 12,
            mode: "100644",
          }],
        },
        payloadStorageKey: "c".repeat(64),
        payloadSha256: "c".repeat(64),
        payloadSizeBytes: 12,
        expiresAt: new Date(Date.now() + 60_000),
      });
      const { row: receipt } = await ensureGitHubPublicationReceipt({
        orgId,
        changeSetId: changeSet.id,
        idempotencyKey: "fence-key",
        targetBranch: "main",
        headBranch: `useagent/${concurrentRunId}`,
        commitMessage: "Update README",
        pullRequestTitle: "Update README",
        pullRequestBody: "Prepared by the agent.",
      });
      const first = await claimGitHubPublicationReceipt(orgId, receipt.id);
      expect(first).not.toBeNull();
      if (!first) throw new Error("expected publication claim");
      const replacementToken = crypto.randomUUID();
      await db
        .update(githubPublicationReceipts)
        .set({ claimToken: replacementToken, claimExpiresAt: new Date(Date.now() + 60_000) })
        .where(eq(githubPublicationReceipts.id, receipt.id));

      await expect(renewGitHubPublicationClaim({
        orgId,
        receiptId: receipt.id,
        claimToken: first.claimToken,
      })).resolves.toBe(false);
      await expect(renewGitHubPublicationClaim({
        orgId,
        receiptId: receipt.id,
        claimToken: replacementToken,
      })).resolves.toBe(true);

      const firstIntent = "d".repeat(40);
      await expect(recordGitHubPublicationIntent({
        orgId,
        receiptId: receipt.id,
        claimToken: replacementToken,
        commitSha: firstIntent,
      })).resolves.toBe(true);
      await expect(recordGitHubPublicationPreRefAbort({
        orgId,
        receiptId: receipt.id,
        claimToken: replacementToken,
        error: "pre_ref_abort:lease_lost",
      })).resolves.toMatchObject({ state: "pending", commitSha: null });

      const retry = await claimGitHubPublicationReceipt(orgId, receipt.id);
      expect(retry).not.toBeNull();
      if (!retry) throw new Error("expected retry publication claim");
      const retryIntent = "e".repeat(40);
      await expect(recordGitHubPublicationIntent({
        orgId,
        receiptId: receipt.id,
        claimToken: retry.claimToken,
        commitSha: retryIntent,
      })).resolves.toBe(true);
      const [retriedReceipt] = await db
        .select({ commitSha: githubPublicationReceipts.commitSha })
        .from(githubPublicationReceipts)
        .where(eq(githubPublicationReceipts.id, receipt.id));
      expect(retriedReceipt?.commitSha).toBe(retryIntent);
    } finally {
      await db.delete(runs).where(eq(runs.id, concurrentRunId));
    }
  });
});
