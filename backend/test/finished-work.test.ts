import { afterEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { artifacts, finishedWorkObligations, finishedWorkReceipts } from "../src/db/schema";
import { evaluateFinishedWork } from "../src/runs/finished-work";
import {
  FinishedWorkIdempotencyConflictError,
  listFinishedWorkForRun,
  openFinishedWorkObligation,
  recordFinishedWorkReceipt,
  resolveFinishedWorkObligation,
} from "../src/runs/finished-work-repo";
import {
  finishedWorkEnforcementEnabled,
  finishedWorkRolloutMode,
} from "../src/runs/finished-work-rollout";
import {
  finalizeRun,
  resolveDurableFinalizationOutcome,
} from "../src/runs/finalize";
import {
  lockFinishedWorkRun,
  resetFinishedWorkSessionLockClientForTest,
  withFinishedWorkSessionLocks,
} from "../src/runs/finished-work-lock";
import { createRun, getRun } from "../src/runs/repo";
import "./helpers";

const ORG = "org-skynet-dev";
const previousRollout = process.env.FINISHED_WORK_ROLLOUT;
const previousEngines = process.env.FINISHED_WORK_ENFORCE_ENGINES;
const previousRuns = process.env.FINISHED_WORK_ENFORCE_RUN_IDS;

async function freshRun(engine: "mock" | "codex" = "mock"): Promise<string> {
  const id = crypto.randomUUID();
  await createRun({
    id,
    prompt: "produce the requested result",
    model: "test",
    engine,
    orgId: ORG,
    userId: null,
    parentRunId: null,
    threadId: id,
  });
  return id;
}

async function childRun(threadId: string, engine: "mock" | "codex" = "mock"): Promise<string> {
  const id = crypto.randomUUID();
  await createRun({
    id,
    prompt: "continue the requested result",
    model: "test",
    engine,
    orgId: ORG,
    userId: null,
    parentRunId: threadId,
    threadId,
  });
  return id;
}

async function artifact(runId: string, threadId = runId): Promise<string> {
  const marker = crypto.randomUUID();
  const [row] = await db.insert(artifacts).values({
    orgId: ORG,
    runId,
    threadId,
    sourcePath: `/sandbox/${marker}.pdf`,
    name: "result.pdf",
    contentType: "application/pdf",
    sizeBytes: 10,
    sha256: "a".repeat(64),
    storageKey: `test/${runId}/${marker}.pdf`,
  }).returning({ id: artifacts.id });
  if (!row) throw new Error("artifact fixture failed");
  return row.id;
}

afterEach(async () => {
  if (previousRollout === undefined) delete process.env.FINISHED_WORK_ROLLOUT;
  else process.env.FINISHED_WORK_ROLLOUT = previousRollout;
  if (previousEngines === undefined) delete process.env.FINISHED_WORK_ENFORCE_ENGINES;
  else process.env.FINISHED_WORK_ENFORCE_ENGINES = previousEngines;
  if (previousRuns === undefined) delete process.env.FINISHED_WORK_ENFORCE_RUN_IDS;
  else process.env.FINISHED_WORK_ENFORCE_RUN_IDS = previousRuns;
  await resetFinishedWorkSessionLockClientForTest();
});

describe("finished work rollout", () => {
  test("defaults invalid values to off and narrows enforcement by engine/run", () => {
    expect(finishedWorkRolloutMode({})).toBe("off");
    expect(finishedWorkRolloutMode({ FINISHED_WORK_ROLLOUT: "bogus" })).toBe("off");
    expect(finishedWorkRolloutMode({ FINISHED_WORK_ROLLOUT: " SHADOW " })).toBe("shadow");
    expect(finishedWorkEnforcementEnabled("codex", "run-1", {
      FINISHED_WORK_ROLLOUT: "enforce",
      FINISHED_WORK_ENFORCE_ENGINES: "codex",
      FINISHED_WORK_ENFORCE_RUN_IDS: "run-1",
    })).toBe(true);
    expect(finishedWorkEnforcementEnabled("opencode", "run-1", {
      FINISHED_WORK_ROLLOUT: "enforce",
      FINISHED_WORK_ENFORCE_ENGINES: "codex",
    })).toBe(false);
    expect(finishedWorkEnforcementEnabled("codex", "run-2", {
      FINISHED_WORK_ROLLOUT: "enforce",
      FINISHED_WORK_ENFORCE_RUN_IDS: "run-1",
    })).toBe(false);
  });
});

describe("finished work persistence", () => {
  test("legacy evidence with no obligations is explicitly not required", () => {
    expect(evaluateFinishedWork({ obligations: [], receipts: [] })).toEqual({
      status: "not_required",
      reason: "no_material_output_observed",
    });
  });

  test("opens idempotently, rejects changed reuse, and never accepts raw paths", async () => {
    const runId = await freshRun();
    const first = await openFinishedWorkObligation({
      orgId: ORG,
      runId,
      sourceKind: "gateway_tool",
      authority: "integration_gateway",
      sourceKey: "artifact.publish:call-1",
      requirement: "artifact_create",
      sourceProvider: "useagent",
      sourceCallId: "call-1",
      candidateName: "Quarterly report.pdf",
    });
    expect(first.created).toBe(true);
    expect((await openFinishedWorkObligation({
      orgId: ORG,
      runId,
      sourceKind: "gateway_tool",
      authority: "integration_gateway",
      sourceKey: "artifact.publish:call-1",
      requirement: "artifact_create",
      sourceProvider: "useagent",
      sourceCallId: "call-1",
      candidateName: "Quarterly report.pdf",
    })).created).toBe(false);
    await expect(openFinishedWorkObligation({
      orgId: ORG,
      runId,
      sourceKind: "gateway_tool",
      authority: "integration_gateway",
      sourceKey: "artifact.publish:call-1",
      requirement: "external_action",
    })).rejects.toBeInstanceOf(FinishedWorkIdempotencyConflictError);
    await expect(openFinishedWorkObligation({
      orgId: ORG,
      runId,
      sourceKind: "sandbox_output",
      authority: "integration_gateway",
      sourceKey: "/root/work/result.pdf",
      requirement: "artifact_create",
    })).rejects.toThrow("bounded opaque identifier");
    await expect(openFinishedWorkObligation({
      orgId: ORG,
      runId,
      sourceKind: "sandbox_output",
      authority: "integration_gateway",
      sourceKey: "candidate-2",
      requirement: "artifact_create",
      candidateName: "/root/work/result.pdf",
    })).rejects.toThrow("safe display name");
    await expect(openFinishedWorkObligation({
      orgId: ORG,
      runId,
      sourceKind: "sandbox_output",
      authority: "provider_adapter",
      sourceKey: "sandbox:candidate-3",
      requirement: "artifact_create",
    })).rejects.toThrow("cannot open an obligation");
  });

  test("a matching receipt satisfies one obligation atomically and idempotently", async () => {
    const runId = await freshRun();
    const artifactId = await artifact(runId);
    const { row: obligation } = await openFinishedWorkObligation({
      orgId: ORG,
      runId,
      sourceKind: "gateway_tool",
      authority: "integration_gateway",
      sourceKey: "artifact.publish:call-2",
      requirement: "artifact_create",
      candidateName: "result.pdf",
    });
    const input = {
      orgId: ORG,
      runId,
      obligationId: obligation.id,
      kind: "artifact_created" as const,
      authority: "artifact_store" as const,
      sourceKey: "artifact.store:receipt-2",
      artifactId,
      metadata: { digest: "a".repeat(64), mime: "application/pdf", count: 1 },
    };
    expect((await recordFinishedWorkReceipt(input)).created).toBe(true);
    expect((await recordFinishedWorkReceipt(input)).created).toBe(false);
    const state = await listFinishedWorkForRun(ORG, runId);
    expect(state.obligations).toHaveLength(1);
    expect(state.obligations[0]?.state).toBe("satisfied");
    expect(state.receipts).toHaveLength(1);
    expect(evaluateFinishedWork(state).status).toBe("ready");
  });

  test("read-only and repository receipts cannot satisfy artifact obligations", async () => {
    const runId = await freshRun();
    const { row: obligation } = await openFinishedWorkObligation({
      orgId: ORG,
      runId,
      sourceKind: "provider_native",
      authority: "provider_adapter",
      sourceKey: "native:call-3",
      requirement: "artifact_create",
    });
    for (const kind of ["read_only_answer", "repository_changed"] as const) {
      await expect(recordFinishedWorkReceipt({
        orgId: ORG,
        runId,
        obligationId: obligation.id,
        kind,
        authority: kind === "read_only_answer" ? "run_engine" : "github_publication",
        sourceKey: `engine:${kind}`,
      })).rejects.toThrow(`cannot satisfy artifact_create`);
    }
    await expect(recordFinishedWorkReceipt({
      orgId: ORG,
      runId,
      kind: "read_only_answer",
      authority: "run_engine",
      sourceKey: "engine:answer",
      metadata: { rawArgs: "secret" } as never,
    })).rejects.toThrow("metadata key is not allowed");
  });

  test("artifact receipts are bound to the creating run and exact update target", async () => {
    const rootRunId = await freshRun();
    const runId = await childRun(rootRunId);
    const targetArtifactId = await artifact(rootRunId, rootRunId);
    const wrongArtifactId = await artifact(runId, rootRunId);
    const { row: obligation } = await openFinishedWorkObligation({
      orgId: ORG,
      runId,
      sourceKind: "gateway_tool",
      authority: "integration_gateway",
      sourceKey: "artifact.update:call-5",
      requirement: "artifact_update",
      targetArtifactId,
    });

    await expect(recordFinishedWorkReceipt({
      orgId: ORG,
      runId,
      obligationId: obligation.id,
      kind: "artifact_updated",
      authority: "workpiece_store",
      sourceKey: "artifact.update:wrong-target",
      artifactId: wrongArtifactId,
    })).rejects.toThrow("target artifact");
    await expect(recordFinishedWorkReceipt({
      orgId: ORG,
      runId,
      kind: "artifact_created",
      authority: "artifact_store",
      sourceKey: "artifact.create:wrong-run",
      artifactId: targetArtifactId,
    })).rejects.toThrow("current run");
    await expect(db.insert(finishedWorkReceipts).values({
      orgId: ORG,
      runId,
      threadId: rootRunId,
      obligationId: obligation.id,
      kind: "artifact_updated",
      authority: "workpiece_store",
      sourceKey: "artifact.update:direct-wrong-target",
      artifactId: wrongArtifactId,
    }).execute()).rejects.toThrow();
    await expect(db.insert(finishedWorkReceipts).values({
      orgId: ORG,
      runId,
      threadId: rootRunId,
      kind: "artifact_created",
      authority: "artifact_store",
      sourceKey: "artifact.create:direct-wrong-run",
      artifactId: targetArtifactId,
    }).execute()).rejects.toThrow();
  });

  test("metadata rejects nested sensitive keys, paths, and token-bearing URLs", async () => {
    const runId = await freshRun();
    const base = {
      orgId: ORG,
      runId,
      kind: "read_only_answer" as const,
      authority: "run_engine" as const,
    };
    await expect(recordFinishedWorkReceipt({
      ...base,
      sourceKey: "engine:unsafe-counts",
      metadata: { counts: { accessToken: 1 } } as never,
    })).rejects.toThrow("metadata key is not allowed");
    await expect(recordFinishedWorkReceipt({
      ...base,
      sourceKey: "engine:unsafe-path",
      metadata: { digest: "/root/work/secret" },
    })).rejects.toThrow("digest is invalid");
    await expect(recordFinishedWorkReceipt({
      ...base,
      sourceKey: "engine:unsafe-url",
      metadata: { pullRequestUrl: "https://example.com/pull/1?token=secret" },
    })).rejects.toThrow("pullRequestUrl is invalid");
    for (const [index, pullRequestUrl] of [
      "https://github.com/acme/widget/pull/1?token=secret",
      "https://github.com/acme/widget/pull/1%3Ftoken=secret",
      "https://github.com/acme/widget/pull%2F1",
      "https://token@github.com/acme/widget/pull/1",
      "https://github.com/acme/widget/issues/1",
      "https://github.com/./widget/pull/1",
      "https://github.com/../widget/pull/1",
      "https://github.com/acme/./pull/1",
      "https://github.com/acme/../pull/1",
      "https://github.com/%2e/widget/pull/1",
      "https://github.com/acme/%2e%2e/pull/1",
      "https://github.com/acme/widget/pull/01",
    ].entries()) {
      await expect(recordFinishedWorkReceipt({
        ...base,
        sourceKey: `engine:unsafe-pr-${index}`,
        metadata: { pullRequestUrl },
      })).rejects.toThrow("pullRequestUrl is invalid");
    }
    await expect(recordFinishedWorkReceipt({
      ...base,
      sourceKey: "engine:unsafe-mime-path",
      metadata: { mime: "application/pdf/private" },
    })).rejects.toThrow("mime is invalid");
    expect((await recordFinishedWorkReceipt({
      ...base,
      sourceKey: "engine:valid-pr",
      metadata: {
        mime: "application/vnd.api+json",
        pullRequestUrl: "https://github.com/acme/widget/pull/42",
      },
    })).created).toBe(true);
  });

  test("failed obligations produce bounded failure decisions", async () => {
    const runId = await freshRun();
    const { row: obligation } = await openFinishedWorkObligation({
      orgId: ORG,
      runId,
      sourceKind: "gateway_tool",
      authority: "integration_gateway",
      sourceKey: "integration:call-4",
      requirement: "external_action",
    });
    await resolveFinishedWorkObligation({
      orgId: ORG,
      runId,
      obligationId: obligation.id,
      state: "failed",
      failureCode: "provider_rejected",
    });
    const decision = evaluateFinishedWork(await listFinishedWorkForRun(ORG, runId));
    expect(decision).toMatchObject({ status: "failed", failureCodes: ["provider_rejected"] });
  });

  test("database checks reject unsafe direct writes", async () => {
    const runId = await freshRun();
    await expect(db.insert(finishedWorkObligations).values({
      orgId: ORG,
      runId,
      threadId: runId,
      sourceKind: "gateway_tool",
      authority: "integration_gateway",
      sourceKey: "/raw/path",
      requirement: "artifact_create",
    }).execute()).rejects.toThrow();
    await expect(db.insert(finishedWorkReceipts).values({
      orgId: ORG,
      runId,
      threadId: runId,
      kind: "read_only_answer",
      authority: "run_engine",
      sourceKey: "engine:direct",
      metadata: { rawArgs: "secret" } as never,
    }).execute()).rejects.toThrow();
    await expect(db.insert(finishedWorkObligations).values({
      orgId: ORG,
      runId,
      threadId: runId,
      sourceKind: "sandbox_output",
      authority: "provider_adapter",
      sourceKey: "sandbox:untrusted",
      requirement: "artifact_create",
    }).execute()).rejects.toThrow();
    await expect(db.insert(finishedWorkReceipts).values({
      orgId: ORG,
      runId,
      threadId: runId,
      kind: "repository_changed",
      authority: "run_engine",
      sourceKey: "repository:wrong-authority",
    }).execute()).rejects.toThrow();
    await expect(db.insert(finishedWorkReceipts).values({
      orgId: ORG,
      runId,
      threadId: runId,
      kind: "read_only_answer",
      authority: "run_engine",
      sourceKey: "engine:token-url",
      metadata: { pullRequestUrl: "https://example.com/pull/1?token=secret" },
    }).execute()).rejects.toThrow();
    for (const [index, metadata] of [
      { pullRequestUrl: "https://github.com/acme/widget/pull/1?token=secret" },
      { pullRequestUrl: "https://github.com/acme/widget/pull/1%3Ftoken=secret" },
      { pullRequestUrl: "https://github.com/acme/widget/pull%2F1" },
      { pullRequestUrl: "https://github.com/./widget/pull/1" },
      { pullRequestUrl: "https://github.com/../widget/pull/1" },
      { pullRequestUrl: "https://github.com/acme/./pull/1" },
      { pullRequestUrl: "https://github.com/acme/../pull/1" },
      { pullRequestUrl: "https://github.com/%2e/widget/pull/1" },
      { pullRequestUrl: "https://github.com/acme/%2e%2e/pull/1" },
      { pullRequestUrl: "https://github.com/acme/widget/pull/01" },
      { mime: "application/pdf/private" },
    ].entries()) {
      await expect(db.insert(finishedWorkReceipts).values({
        orgId: ORG,
        runId,
        threadId: runId,
        kind: "read_only_answer",
        authority: "run_engine",
        sourceKey: `engine:direct-unsafe-${index}`,
        metadata,
      }).execute()).rejects.toThrow();
    }
  });

  test("database receipts are append-only even for the privileged role", async () => {
    const runId = await freshRun();
    const artifactId = await artifact(runId);
    const { row: obligation } = await openFinishedWorkObligation({
      orgId: ORG,
      runId,
      sourceKind: "gateway_tool",
      authority: "integration_gateway",
      sourceKey: "artifact:immutable-receipt",
      requirement: "artifact_create",
    });
    const { row: receipt } = await recordFinishedWorkReceipt({
      orgId: ORG,
      runId,
      obligationId: obligation.id,
      kind: "artifact_created",
      authority: "artifact_store",
      sourceKey: "artifact:immutable-receipt",
      artifactId,
      artifactRevision: 0,
    });
    await expect(db
      .update(finishedWorkReceipts)
      .set({ artifactRevision: 1 })
      .where(sql`${finishedWorkReceipts.id} = ${receipt.id}`)
      .execute())
      .rejects.toThrow();
  });

  test("database defers satisfied state until exactly one scoped receipt exists", async () => {
    const runId = await freshRun();
    const artifactId = await artifact(runId);
    const { row: obligation } = await openFinishedWorkObligation({
      orgId: ORG,
      runId,
      sourceKind: "gateway_tool",
      authority: "integration_gateway",
      sourceKey: "artifact:direct-satisfied",
      requirement: "artifact_create",
    });
    await expect(db.transaction(async (tx) => {
      await tx.execute(sql`
        update finished_work_obligations
        set state = 'satisfied', resolved_at = now()
        where id = ${obligation.id}
      `);
    })).rejects.toThrow("exactly one matching scoped receipt");

    await recordFinishedWorkReceipt({
      orgId: ORG,
      runId,
      obligationId: obligation.id,
      kind: "artifact_created",
      authority: "artifact_store",
      sourceKey: "artifact:direct-satisfied:receipt",
      artifactId,
    });
    const replacementArtifactId = await artifact(runId);
    await expect(db.transaction(async (tx) => {
      await tx.execute(sql`
        update finished_work_obligations
        set requirement = 'artifact_update', target_artifact_id = ${replacementArtifactId}
        where id = ${obligation.id}
      `);
    })).rejects.toThrow();
    await expect(db.transaction(async (tx) => {
      await tx.execute(sql`
        update finished_work_receipts
        set kind = 'artifact_updated', artifact_id = ${replacementArtifactId}
        where obligation_id = ${obligation.id}
      `);
    })).rejects.toThrow();
    await expect(db.transaction(async (tx) => {
      await tx.execute(sql`
        delete from finished_work_receipts where obligation_id = ${obligation.id}
      `);
    })).rejects.toThrow("exactly one matching scoped receipt");
  });

  test("database composite keys reject cross-organization and cross-run writes", async () => {
    const runId = await freshRun();
    await expect(db.insert(finishedWorkObligations).values({
      orgId: "org-other",
      runId,
      threadId: runId,
      sourceKind: "gateway_tool",
      authority: "integration_gateway",
      sourceKey: "cross-org:obligation",
      requirement: "artifact_create",
    }).execute()).rejects.toThrow();

    const { row: obligation } = await openFinishedWorkObligation({
      orgId: ORG,
      runId,
      sourceKind: "gateway_tool",
      authority: "integration_gateway",
      sourceKey: "scoped:obligation",
      requirement: "artifact_create",
    });
    const otherRunId = await freshRun();
    await expect(db.insert(finishedWorkReceipts).values({
      orgId: ORG,
      runId: otherRunId,
      threadId: otherRunId,
      obligationId: obligation.id,
      kind: "read_only_answer",
      authority: "run_engine",
      sourceKey: "cross-run:receipt",
    }).execute()).rejects.toThrow();
  });
});

describe("finished work finalization", () => {
  test("legacy runs with no obligations remain completed in enforce mode", async () => {
    process.env.FINISHED_WORK_ROLLOUT = "enforce";
    const runId = await freshRun("codex");
    const result = await finalizeRun(runId, "completed", "answered", 10);
    expect(result).toEqual({ applied: true, status: "completed", summary: "answered" });
    expect((await getRun(runId))?.status).toBe("completed");
  });

  test("off and shadow preserve completion with an open obligation", async () => {
    for (const mode of ["off", "shadow"] as const) {
      process.env.FINISHED_WORK_ROLLOUT = mode;
      const runId = await freshRun("codex");
      await openFinishedWorkObligation({
        orgId: ORG,
        runId,
        sourceKind: "gateway_tool",
        authority: "integration_gateway",
        sourceKey: `artifact:${mode}`,
        requirement: "artifact_create",
      });
      const result = await finalizeRun(runId, "completed", "claimed done", 10);
      expect(result).toEqual({ applied: true, status: "completed", summary: "claimed done" });
      expect((await getRun(runId))?.status).toBe("completed");
    }
  });

  test("enforce returns and persists the effective failure", async () => {
    process.env.FINISHED_WORK_ROLLOUT = "enforce";
    process.env.FINISHED_WORK_ENFORCE_ENGINES = "codex";
    const runId = await freshRun("codex");
    await openFinishedWorkObligation({
      orgId: ORG,
      runId,
      sourceKind: "gateway_tool",
      authority: "integration_gateway",
      sourceKey: "artifact:enforce",
      requirement: "artifact_create",
    });
    const result = await finalizeRun(runId, "completed", "claimed done", 10);
    expect(result).toMatchObject({ applied: true, status: "failed" });
    expect(result.applied && result.summary).toContain("required finished work was not produced");
    expect((await getRun(runId))?.status).toBe("failed");
    expect((await getRun(runId))?.summary).toBe(result.applied ? result.summary : null);
    expect(await finalizeRun(runId, "completed", "second claim", 10)).toEqual({ applied: false });
  });

  test("receipt and finalizer serialize on one run lock", async () => {
    process.env.FINISHED_WORK_ROLLOUT = "enforce";
    const runId = await freshRun("codex");
    const artifactId = await artifact(runId);
    const { row: obligation } = await openFinishedWorkObligation({
      orgId: ORG,
      runId,
      sourceKind: "gateway_tool",
      authority: "integration_gateway",
      sourceKey: "artifact:race",
      requirement: "artifact_create",
    });
    let releaseLock!: () => void;
    let reportLocked!: () => void;
    const release = new Promise<void>((resolve) => { releaseLock = resolve; });
    const locked = new Promise<void>((resolve) => { reportLocked = resolve; });
    const receipt = db.transaction(async (tx) => {
      await lockFinishedWorkRun(runId, tx);
      reportLocked();
      await release;
      return recordFinishedWorkReceipt({
        orgId: ORG,
        runId,
        obligationId: obligation.id,
        kind: "artifact_created",
        authority: "artifact_store",
        sourceKey: "artifact:race:receipt",
        artifactId,
      }, tx);
    });
    await locked;
    const finalizing = finalizeRun(runId, "completed", "finished", 10);
    releaseLock();
    await receipt;
    const finalized = await finalizing;
    expect(finalized).toEqual({ applied: true, status: "completed", summary: "finished" });
    expect((await listFinishedWorkForRun(ORG, runId)).obligations[0]?.state).toBe("satisfied");
  });

  test("rolls back a failed dedicated lock transaction before finalization reuses the run key", async () => {
    process.env.FINISHED_WORK_ROLLOUT = "shadow";
    const runId = await freshRun("codex");
    await expect(withFinishedWorkSessionLocks(runId, "injected-failure", async () => {
      await db.transaction((tx) => tx.execute(sql`select 1`));
      throw new Error("injected lock callback failure");
    })).rejects.toThrow("injected lock callback failure");

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      finalizeRun(runId, "completed", "lock released", 10),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("finalizer could not reacquire the run lock")), 2_000);
      }),
    ]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });
    expect(result).toEqual({ applied: true, status: "completed", summary: "lock released" });
  });

  test("finalizer wins and fences late writes while exact obligation and receipt replays remain idempotent", async () => {
    process.env.FINISHED_WORK_ROLLOUT = "enforce";
    const runId = await freshRun("codex");
    const artifactId = await artifact(runId);
    const obligationInput = {
      orgId: ORG,
      runId,
      sourceKind: "gateway_tool" as const,
      authority: "integration_gateway" as const,
      sourceKey: "artifact:terminal-fence",
      requirement: "artifact_create" as const,
    };
    const { row: obligation } = await openFinishedWorkObligation(obligationInput);
    const receiptInput = {
      orgId: ORG,
      runId,
      obligationId: obligation.id,
      kind: "artifact_created" as const,
      authority: "artifact_store" as const,
      sourceKey: "artifact:terminal-fence:receipt",
      artifactId,
    };
    await recordFinishedWorkReceipt(receiptInput);
    expect(await finalizeRun(runId, "completed", "finished", 10)).toMatchObject({
      applied: true,
      status: "completed",
    });

    expect((await openFinishedWorkObligation(obligationInput)).created).toBe(false);
    expect((await recordFinishedWorkReceipt(receiptInput)).created).toBe(false);
    await expect(openFinishedWorkObligation({
      ...obligationInput,
      sourceKey: "artifact:terminal-fence:late",
    })).rejects.toThrow("closed after run settlement");
    await expect(recordFinishedWorkReceipt({
      orgId: ORG,
      runId,
      kind: "read_only_answer",
      authority: "run_engine",
      sourceKey: "engine:terminal-fence:late",
    })).rejects.toThrow("closed after run settlement");
    await expect(resolveFinishedWorkObligation({
      orgId: ORG,
      runId,
      obligationId: obligation.id,
      state: "waived",
    })).rejects.toBeInstanceOf(FinishedWorkIdempotencyConflictError);
  });

  test("exact failed and waived resolution replays survive settlement", async () => {
    for (const state of ["failed", "waived"] as const) {
      const runId = await freshRun("codex");
      const { row: obligation } = await openFinishedWorkObligation({
        orgId: ORG,
        runId,
        sourceKind: "gateway_tool",
        authority: "integration_gateway",
        sourceKey: `terminal-resolution:${state}`,
        requirement: "external_action",
      });
      const failureCode = state === "failed" ? "provider_rejected" : null;
      const resolved = await resolveFinishedWorkObligation({
        orgId: ORG,
        runId,
        obligationId: obligation.id,
        state,
        failureCode,
      });
      await finalizeRun(runId, "completed", "settled", 10);

      expect(await resolveFinishedWorkObligation({
        orgId: ORG,
        runId,
        obligationId: obligation.id,
        state,
        failureCode,
      })).toEqual(resolved);
      await expect(resolveFinishedWorkObligation({
        orgId: ORG,
        runId,
        obligationId: obligation.id,
        state: state === "failed" ? "waived" : "failed",
        failureCode: state === "failed" ? null : "different_outcome",
      })).rejects.toBeInstanceOf(FinishedWorkIdempotencyConflictError);
    }
  });

  test("off finalization does not wait on the finished-work advisory lock", async () => {
    process.env.FINISHED_WORK_ROLLOUT = "off";
    const runId = await freshRun("codex");
    let releaseLock!: () => void;
    let reportLocked!: () => void;
    const release = new Promise<void>((resolve) => { releaseLock = resolve; });
    const locked = new Promise<void>((resolve) => { reportLocked = resolve; });
    const holder = db.transaction(async (tx) => {
      await lockFinishedWorkRun(runId, tx);
      reportLocked();
      await release;
    });
    await locked;
    const finalizing = finalizeRun(runId, "completed", "off path", 10);
    const result = await Promise.race([
      finalizing,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 500)),
    ]);
    releaseLock();
    await holder;
    expect(result).not.toBe("timeout");
    expect(await finalizing).toMatchObject({ applied: true, status: "completed" });
  });

  test("finalization losers resolve the durable first-writer outcome", async () => {
    const runId = await freshRun("codex");
    const [left, right] = await Promise.all([
      finalizeRun(runId, "completed", "winner completed", 1),
      finalizeRun(runId, "failed", "winner failed", 1),
    ]);
    expect([left, right].filter((result) => result.applied)).toHaveLength(1);
    const leftDurable = await resolveDurableFinalizationOutcome(runId, left);
    const rightDurable = await resolveDurableFinalizationOutcome(runId, right);
    expect(leftDurable).toEqual(rightDurable);
    expect(leftDurable?.status).toBe((await getRun(runId))?.status);
  });

  test("requested failure remains failed regardless of finished-work state", async () => {
    process.env.FINISHED_WORK_ROLLOUT = "enforce";
    const runId = await freshRun("codex");
    const result = await finalizeRun(runId, "failed", "provider failed", 10);
    expect(result).toEqual({ applied: true, status: "failed", summary: "provider failed" });
  });
});
