import { afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db } from "../src/db/client";
import { runs } from "../src/db/schema";
import {
  ensureGitHubPublicationReceipt,
  freezeGitHubChangeSet,
  GitHubPublicationIdempotencyConflictError,
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
        files: [{ path: "README.md", action: "modify", sha256: "b".repeat(64), sizeBytes: 12 }],
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
});
