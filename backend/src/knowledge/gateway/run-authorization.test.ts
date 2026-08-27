import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "../../index";
import { db } from "../../db/client";
import { runs } from "../../db/schema";
import {
  resolveAuthorizedToolRun,
  resolveToolRunIdentity,
} from "./run-authorization";
import type { ToolTokenClaims } from "./token";

const createdRunIds = new Set<string>();

afterEach(async () => {
  for (const id of createdRunIds) {
    await db.delete(runs).where(eq(runs.id, id));
  }
  createdRunIds.clear();
});

function claims(input: {
  readonly orgId: string;
  readonly userId: string;
  readonly threadId: string;
  readonly runId: string;
  readonly scope: "run" | "thread";
}): ToolTokenClaims {
  return { ...input, exp: Date.now() + 60_000 };
}

async function insertRun(input: {
  readonly id: string;
  readonly orgId: string;
  readonly userId: string | null;
  readonly threadId: string;
  readonly status: "running" | "completed";
  readonly memoryScope?: "personal" | "org";
  readonly origin?: string | null;
}): Promise<void> {
  createdRunIds.add(input.id);
  await db.insert(runs).values({
    ...input,
    prompt: "gateway authorization test",
    model: "gpt-5",
    engine: "opencode",
    memoryScope: input.memoryScope ?? "org",
  });
}

describe("knowledge gateway run authorization", () => {
  test("returns the authoritative run identity and current memory scope", async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const threadId = `thread-${crypto.randomUUID()}`;
    const runId = `run-${crypto.randomUUID()}`;
    await insertRun({
      id: runId,
      orgId,
      userId: "user-a",
      threadId,
      status: "running",
      memoryScope: "personal",
      origin: "internal:release-parity",
    });

    const tokenClaims = claims({
      orgId,
      userId: "user-a",
      threadId,
      runId,
      scope: "run",
    });

    expect(await resolveAuthorizedToolRun(tokenClaims)).toEqual({
      id: runId,
      orgId,
      userId: "user-a",
      threadId,
      memoryScope: "personal",
      origin: "internal:release-parity",
    });
    expect(await resolveToolRunIdentity(tokenClaims)).toEqual(tokenClaims);
  });

  test("thread scope resolves exactly one matching live run", async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const threadId = `thread-${crypto.randomUUID()}`;
    const mintRunId = `run-${crypto.randomUUID()}`;
    const liveRunId = `run-${crypto.randomUUID()}`;
    await insertRun({
      id: mintRunId,
      orgId,
      userId: "user-a",
      threadId,
      status: "completed",
    });
    await insertRun({
      id: liveRunId,
      orgId,
      userId: "user-a",
      threadId,
      status: "running",
    });

    const tokenClaims = claims({
      orgId,
      userId: "user-a",
      threadId,
      runId: mintRunId,
      scope: "thread",
    });

    expect(await resolveAuthorizedToolRun(tokenClaims)).toMatchObject({ id: liveRunId });
    expect(await resolveToolRunIdentity(tokenClaims)).toEqual({
      ...tokenClaims,
      runId: liveRunId,
    });
  });

  test("fails closed on ambiguous live runs or any identity mismatch", async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const threadId = `thread-${crypto.randomUUID()}`;
    const firstRunId = `run-${crypto.randomUUID()}`;
    const secondRunId = `run-${crypto.randomUUID()}`;
    await insertRun({
      id: firstRunId,
      orgId,
      userId: "user-a",
      threadId,
      status: "running",
    });
    await insertRun({
      id: secondRunId,
      orgId,
      userId: "user-a",
      threadId,
      status: "running",
    });

    const tokenClaims = claims({
      orgId,
      userId: "user-a",
      threadId,
      runId: firstRunId,
      scope: "thread",
    });

    expect(await resolveAuthorizedToolRun(tokenClaims)).toBeNull();

    await db.update(runs).set({ status: "completed" }).where(eq(runs.id, secondRunId));
    expect(await resolveAuthorizedToolRun({ ...tokenClaims, orgId: "other-org" })).toBeNull();
    expect(await resolveAuthorizedToolRun({ ...tokenClaims, threadId: "other-thread" })).toBeNull();
    expect(await resolveAuthorizedToolRun({ ...tokenClaims, userId: "user-b" })).toBeNull();
  });
});
