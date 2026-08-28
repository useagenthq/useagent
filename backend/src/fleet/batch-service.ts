import { sql } from "drizzle-orm";
import { db, type Executor } from "../db/client";
import { ENGINE_IDS, type EngineId } from "../db/schema";
import { insertCommandWithRun } from "../commands/repo";
import { assertRunAdmissionOpen } from "../commands/admission";
import { runIntentFingerprint } from "../commands/fingerprint";
import type { RunCommandIntent, RunCommandInput } from "../commands/types";
import {
  explicitRepositoryResources,
  resolveRunIntake,
  RunIntakeError,
  type RunResource,
} from "../resources/run-intake";
import { createRunResourceAuthorization } from "../resources/authorization";
import {
  defaultModelForEngine,
  isModelAllowedForEngine,
} from "../runs/model-policy";
import {
  engineResolutionErrorBody,
  modelProviderReadinessErrorBody,
  modelProviderReadyForEngine,
  resolveAcceptedEngine,
} from "../runs/engine-readiness";
import { publishRunLifecycleChange } from "../runs/org-signals";
import {
  ensureFleetBatch,
  getFleetBatchForOrg,
  preflightFleetBatch,
  type FleetBatchView,
} from "./batch-repo";
import type { Context } from "hono";
import type { AppEnv } from "../http";

const MAX_BATCH_ITEMS = 20;
const MAX_COMMAND_PAYLOAD = 8_192;
const TASK_KEYS = new Set(["prompt", "engine", "model", "repos"]);
const BODY_KEYS = new Set(["tasks"]);

export interface FleetBatchTaskInput {
  readonly prompt: string;
  readonly engine: EngineId | null;
  readonly model: string | null;
  readonly repos: readonly string[];
}

interface ResolvedFleetBatchTask {
  readonly input: FleetBatchTaskInput;
  readonly engine: EngineId;
  readonly model: string;
  readonly repos: string[];
  readonly resources: readonly RunResource[];
}

export type FleetBatchValidationResult =
  | { readonly ok: true; readonly tasks: readonly FleetBatchTaskInput[]; readonly fingerprint: string }
  | { readonly ok: false; readonly status: 400; readonly body: { readonly error: string; readonly index?: number } };

export type FleetBatchResolveResult =
  | { readonly ok: true; readonly tasks: readonly ResolvedFleetBatchTask[] }
  | { readonly ok: false; readonly status: 400 | 403; readonly body: Record<string, unknown> };

export interface FleetBatchAcceptance {
  readonly created: boolean;
  readonly batch: FleetBatchView;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function normalizeTask(value: unknown): FleetBatchTaskInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const task = value as Record<string, unknown>;
  if (!hasOnlyKeys(task, TASK_KEYS)) return null;

  const prompt = typeof task.prompt === "string" ? task.prompt.trim() : "";
  if (!prompt) return null;

  let engine: EngineId | null = null;
  if (task.engine !== undefined && task.engine !== null && task.engine !== "") {
    if (typeof task.engine !== "string" || !(ENGINE_IDS as readonly string[]).includes(task.engine)) {
      return null;
    }
    engine = task.engine as EngineId;
  }

  const model = task.model === undefined || task.model === null || task.model === ""
    ? null
    : typeof task.model === "string" && task.model.trim()
      ? task.model.trim()
      : null;
  if (task.model !== undefined && task.model !== null && task.model !== "" && model === null) {
    return null;
  }

  const rawRepos = task.repos ?? [];
  if (!Array.isArray(rawRepos)) return null;
  const repos = rawRepos.map((repo) => typeof repo === "string" ? repo.trim() : "");
  if (repos.some((repo) => !repo) || new Set(repos).size !== repos.length) return null;

  return { prompt, engine, model, repos };
}

/** Parse the narrow public request shape and fingerprint only caller-owned
 * intent. Server trust fields are rejected by the exact key allowlists. */
export function validateFleetBatchBody(body: unknown): FleetBatchValidationResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, status: 400, body: { error: "invalid_batch_body" } };
  }
  const record = body as Record<string, unknown>;
  if (!hasOnlyKeys(record, BODY_KEYS) || !Array.isArray(record.tasks)) {
    return { ok: false, status: 400, body: { error: "invalid_batch_body" } };
  }
  if (record.tasks.length < 1 || record.tasks.length > MAX_BATCH_ITEMS) {
    return { ok: false, status: 400, body: { error: "batch_size_must_be_1_to_20" } };
  }

  const tasks: FleetBatchTaskInput[] = [];
  for (const [index, raw] of record.tasks.entries()) {
    const parsed = normalizeTask(raw);
    if (!parsed) {
      return { ok: false, status: 400, body: { error: "invalid_batch_task", index } };
    }
    tasks.push(parsed);
  }
  const canonical = JSON.stringify(tasks.map((task) => [
    task.prompt,
    task.engine,
    task.model,
    task.repos,
  ]));
  const fingerprint = new Bun.CryptoHasher("sha256").update(canonical).digest("hex");
  return { ok: true, tasks, fingerprint };
}

export async function resolveFleetBatchTasks(
  orgId: string,
  tasks: readonly FleetBatchTaskInput[],
): Promise<FleetBatchResolveResult> {
  const resolved: ResolvedFleetBatchTask[] = [];
  for (const [index, task] of tasks.entries()) {
    const engineResolution = resolveAcceptedEngine(task.engine);
    if (!engineResolution.ok) {
      return {
        ok: false,
        status: engineResolution.status,
        body: { ...engineResolutionErrorBody(engineResolution), index },
      };
    }
    const engine = engineResolution.engine;
    const model = task.model ?? defaultModelForEngine(engine);
    if (!isModelAllowedForEngine(engine, model)) {
      return { ok: false, status: 400, body: { error: "model_not_allowed", engine, model, index } };
    }
    if (!modelProviderReadyForEngine(engine, model)) {
      return {
        ok: false,
        status: 403,
        body: { ...modelProviderReadinessErrorBody(engine, model), index },
      };
    }

    try {
      const intake = await resolveRunIntake(
        {
          source: "web",
          text: task.prompt,
          explicitResources: explicitRepositoryResources(task.repos),
        },
        { authorize: createRunResourceAuthorization(orgId) },
      );
      resolved.push({
        input: task,
        engine,
        model,
        repos: [...intake.repos],
        resources: intake.resources,
      });
    } catch (error) {
      if (error instanceof RunIntakeError) {
        return {
          ok: false,
          status: error.code === "resource_unauthorized" ? 403 : 400,
          body: { error: error.code, ...error.diagnostic, index },
        };
      }
      throw error;
    }
  }
  return { ok: true, tasks: resolved };
}

async function lockOrgBatchQueue(exec: Executor, orgId: string): Promise<void> {
  await exec.execute(sql`
    select pg_advisory_xact_lock(hashtext('fleet-org-queue'), hashtext(${orgId}))`);
}

/** Mutation-free exact replay lookup under the same org queue lock used by
 * acceptance. This lets retries bypass later provider/resource drift without
 * permitting concurrent fresh requests to create duplicate roots. */
export function preflightFleetBatchReplay(input: {
  readonly orgId: string;
  readonly actorId: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly itemCount: number;
}): Promise<FleetBatchView | null> {
  return db.transaction(async (tx) => {
    await lockOrgBatchQueue(tx, input.orgId);
    return preflightFleetBatch(input, tx);
  });
}

function commandIntent(task: ResolvedFleetBatchTask): RunCommandIntent {
  return {
    prompt: task.input.prompt,
    model: task.input.model,
    engine: task.input.engine,
    parentRunId: null,
    requestedRepos: [...task.input.repos],
    requestedResources: [],
    attachmentIds: [],
    memoryScope: null,
    skillId: null,
    skillVersion: null,
    commandName: null,
    commandProvider: null,
    commandSessionId: null,
    commandCatalogRevision: null,
  };
}

function acceptedRun(task: ResolvedFleetBatchTask, id: string): RunCommandInput["run"] {
  return {
    id,
    prompt: task.input.prompt,
    model: task.model,
    engine: task.engine,
    parentRunId: null,
    threadId: id,
    repos: [...task.repos],
    resolvedResources: task.resources,
    attachmentIds: [],
    memoryScope: "org",
    skillId: null,
    skillVersion: null,
    skillContentHash: null,
    commandName: null,
    commandProvider: null,
    commandSessionId: null,
    commandCatalogRevision: null,
  };
}

/** Commit the complete fan-out manifest and all accepted roots atomically. */
export async function acceptFleetBatch(input: {
  readonly orgId: string;
  readonly actorId: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly tasks: readonly ResolvedFleetBatchTask[];
}): Promise<FleetBatchAcceptance> {
  const result = await db.transaction(async (tx) => {
    await lockOrgBatchQueue(tx, input.orgId);
    const replay = await preflightFleetBatch({
      orgId: input.orgId,
      actorId: input.actorId,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: input.requestFingerprint,
      itemCount: input.tasks.length,
    }, tx);
    if (replay) return { created: false, batch: replay } as const;

    await assertRunAdmissionOpen(tx);
    const runIds = input.tasks.map(() => crypto.randomUUID());
    for (const [index, task] of input.tasks.entries()) {
      const run = acceptedRun(task, runIds[index]!);
      const intent = commandIntent(task);
      const payload = JSON.stringify({
        prompt: run.prompt,
        model: run.model,
        engine: run.engine,
        parentRunId: null,
        threadId: run.threadId,
        repos: run.repos,
        resolvedResources: run.resolvedResources,
        attachmentIds: [],
        memoryScope: run.memoryScope,
        intent,
      }).slice(0, MAX_COMMAND_PAYLOAD);
      await insertCommandWithRun({
        commandId: crypto.randomUUID(),
        idempotencyKey: null,
        orgId: input.orgId,
        actorId: input.actorId,
        payloadFingerprint: runIntentFingerprint(intent),
        payload,
        run,
        origin: null,
        priority: 0,
      }, tx);
    }
    return ensureFleetBatch({
      orgId: input.orgId,
      actorId: input.actorId,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: input.requestFingerprint,
      runIds,
    }, tx);
  });

  if (result.created) {
    for (const run of result.batch.runs) {
      publishRunLifecycleChange({
        orgId: input.orgId,
        threadId: run.runId,
        runId: run.runId,
        kind: "created",
      });
    }
  }
  return result;
}

export function fleetBatchResponse(
  batch: FleetBatchView,
  replayed: boolean,
): Record<string, unknown> {
  const counts = { queued: 0, running: 0, completed: 0, failed: 0, deleted: 0 };
  for (const run of batch.runs) counts[run.runStatus] += 1;
  const status = counts.failed > 0 || counts.deleted > 0
    ? "failed"
    : counts.completed === batch.itemCount
      ? "completed"
      : counts.running > 0
        ? "running"
        : "queued";
  return {
    batch_id: batch.id,
    replayed,
    status,
    created_at: batch.createdAt.toISOString(),
    counts: { total: batch.itemCount, ...counts },
    runs: batch.runs.map((run) => ({
      ordinal: run.ordinal,
      run_id: run.runId,
      status: run.runStatus,
      queue: run.admissionState
        ? { state: run.admissionState, reason: run.queueReason }
        : null,
    })),
  };
}

export async function readFleetBatchForContext(
  c: Context<AppEnv>,
  batchId: string,
): Promise<FleetBatchView | null> {
  return getFleetBatchForOrg(c.get("orgId"), batchId);
}
