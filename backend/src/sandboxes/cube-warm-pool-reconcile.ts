import { isNotNull } from "drizzle-orm";
import { db } from "../db/client";
import { reconcileQueue, runs } from "../db/schema";
import type { SandboxCreateOptions, SandboxHandle, SandboxProvider } from "./provider";

export const USEAGENT_WARM_POOL_TEMPLATE_LABEL = "skynet-warm-pool-template";

const CUBE_TEMPLATE_LABELS = [
  "cube.master.appsnapshot.template.id",
  "cube.master.appsnapshot.runtime.snapshot.id",
] as const;

export async function durablyBoundSandboxIds(): Promise<ReadonlySet<string>> {
  const [runRows, reconcileRows] = await Promise.all([
    db
      .select({ sandboxId: runs.sandboxId })
      .from(runs)
      .where(isNotNull(runs.sandboxId)),
    db.select({ sandboxId: reconcileQueue.sandboxId }).from(reconcileQueue),
  ]);
  return new Set([
    ...runRows.map((row) => row.sandboxId).filter((id): id is string => Boolean(id)),
    ...reconcileRows.map((row) => row.sandboxId),
  ]);
}

export interface CubeWarmPoolReconcileOptions {
  readonly name: string;
  readonly provider: SandboxProvider;
  readonly createOptions: SandboxCreateOptions;
  readonly ready: SandboxHandle[];
  readonly size: number;
  readonly isStarted: () => boolean;
  readonly protectedSandboxIds: () => Promise<ReadonlySet<string>>;
  readonly proveReady: (sandbox: SandboxHandle) => Promise<void>;
  readonly logger: Pick<typeof console, "log" | "warn">;
}

export function withWarmPoolTemplateLabel(
  createOptions: SandboxCreateOptions,
): SandboxCreateOptions {
  if (!createOptions.snapshot) return createOptions;
  return {
    ...createOptions,
    labels: {
      ...createOptions.labels,
      [USEAGENT_WARM_POOL_TEMPLATE_LABEL]: createOptions.snapshot,
    },
  };
}

export async function reconcileCubeWarmPoolCandidates(
  options: CubeWarmPoolReconcileOptions,
): Promise<number> {
  const candidates = await listPoolCandidates(options.provider, options.createOptions);
  if (candidates.length === 0) return 0;

  let failures = 0;
  const protectedIds = await options.protectedSandboxIds();
  const readyIds = new Set(options.ready.map((sandbox) => sandbox.id));
  for (const candidate of candidates) {
    if (!options.isStarted()) return failures;
    if (readyIds.has(candidate.id)) continue;
    if (protectedIds.has(candidate.id)) continue;
    if (!matchesSnapshot(candidate, options.createOptions.snapshot)) {
      await candidate.delete();
      continue;
    }
    if (options.ready.length >= options.size) {
      await candidate.delete();
      continue;
    }

    let sandbox = candidate;
    try {
      sandbox = await options.provider.get(candidate.id);
      await sandbox.start();
      await options.proveReady(sandbox);
      if (!options.isStarted()) {
        await sandbox.delete();
        return failures;
      }
      options.ready.push(sandbox);
      readyIds.add(sandbox.id);
      options.logger.log(
        `[cube-warm-pool:${options.name}] adopted ${sandbox.id.slice(0, 8)} (${options.ready.length}/${options.size})`,
      );
    } catch (error) {
      failures += 1;
      options.logger.warn(
        `[cube-warm-pool:${options.name}] discarded stale existing ${candidate.id.slice(0, 8)}:`,
        error instanceof Error ? error.message : error,
      );
      await deleteResolvedCandidate(sandbox, candidate);
    }
  }
  return failures;
}

async function listPoolCandidates(
  provider: SandboxProvider,
  createOptions: SandboxCreateOptions,
): Promise<SandboxHandle[]> {
  const candidates: SandboxHandle[] = [];
  for await (const sandbox of provider.list()) {
    if (matchesPoolLabels(sandbox, createOptions.labels)) candidates.push(sandbox);
  }
  return candidates;
}

function matchesPoolLabels(
  sandbox: SandboxHandle,
  expected: SandboxCreateOptions["labels"],
): boolean {
  if (!expected || Object.keys(expected).length === 0) return false;
  const labels = sandbox.labels ?? {};
  const poolLabels = Object.entries(expected).filter(
    ([key]) => key !== USEAGENT_WARM_POOL_TEMPLATE_LABEL,
  );
  if (poolLabels.length === 0) return false;
  return poolLabels.every(([key, value]) => labels[key] === value);
}

function matchesSnapshot(sandbox: SandboxHandle, snapshot: string | undefined): boolean {
  if (!snapshot) return true;
  const labels = sandbox.labels ?? {};
  const ownedTemplate = labels[USEAGENT_WARM_POOL_TEMPLATE_LABEL];
  if (ownedTemplate) return ownedTemplate === snapshot;
  const exposedTemplate = CUBE_TEMPLATE_LABELS.map((key) => labels[key]).find(Boolean);
  return exposedTemplate === snapshot;
}

async function deleteResolvedCandidate(
  sandbox: SandboxHandle,
  candidate: SandboxHandle,
): Promise<void> {
  try {
    await sandbox.delete();
  } catch (error) {
    if (sandbox.id !== candidate.id) await candidate.delete();
    throw error;
  }
}
