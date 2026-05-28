import { ensureSandboxDesktopView, type SandboxDesktop } from "../engines/desktop";
import {
  durablyBoundSandboxIds,
  reconcileCubeWarmPoolCandidates,
  withWarmPoolTemplateLabel,
} from "./cube-warm-pool-reconcile";
import type { SandboxCreateOptions, SandboxHandle, SandboxProvider } from "./provider";

const CUBE_WARM_POOL_SIZE_ENV = "CUBE_WARM_POOL_SIZE";
// Frozen VALUE: operator env var name already set in production host config.
const CUBE_RUNTIME_WARM_POOL_SIZE_ENV = "CUBE_T3_WARM_POOL_SIZE";
export const DEFAULT_CUBE_WARM_POOL_NAME = "default";
const WARM_TIMEOUT_MS = 120_000;
const CLAIM_PROBE_TIMEOUT_SECONDS = 5;
const INITIAL_RETRY_DELAY_MS = 2_000;
const MAX_RETRY_DELAY_MS = 60_000;
type RetryMode = "refill" | "reconcile";

class CleanupDeleteError extends Error {
  override readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message);
    this.name = "CleanupDeleteError";
    this.cause = cause;
  }
}

function configuredPoolSize(
  name: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): number | null {
  const raw = env[name]?.trim();
  if (!raw) return null;
  const size = Number(raw);
  return Number.isInteger(size) && size > 0 ? size : null;
}

export function cubeWarmPoolSize(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number | null {
  return configuredPoolSize(CUBE_WARM_POOL_SIZE_ENV, env);
}

export function cubeRuntimeWarmPoolSize(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number | null {
  return configuredPoolSize(CUBE_RUNTIME_WARM_POOL_SIZE_ENV, env);
}

export interface CubeWarmPoolOptions {
  readonly name?: string;
  readonly provider: SandboxProvider;
  readonly size: number;
  readonly createOptions: SandboxCreateOptions;
  readonly warmDesktop?: (sandbox: SandboxHandle, signal: AbortSignal) => Promise<SandboxDesktop>;
  readonly warmRuntime?: (sandbox: SandboxHandle, signal: AbortSignal) => Promise<void>;
  readonly requireDesktop?: boolean;
  readonly initialRetryDelayMs?: number;
  readonly maxRetryDelayMs?: number;
  readonly refillAfterClaim?: boolean;
  readonly protectedSandboxIds?: () => Promise<ReadonlySet<string>>;
  readonly logger?: Pick<typeof console, "log" | "warn">;
}

export interface CubeWarmPoolStatus {
  readonly target: number;
  readonly ready: number;
  readonly creating: number;
  readonly failures: number;
  readonly started: boolean;
}

export class CubeWarmPool {
  readonly name: string;
  private readonly provider: SandboxProvider;
  private readonly size: number;
  private readonly createOptions: SandboxCreateOptions;
  private readonly warmDesktop: (
    sandbox: SandboxHandle,
    signal: AbortSignal,
  ) => Promise<SandboxDesktop>;
  private readonly warmRuntime: (sandbox: SandboxHandle, signal: AbortSignal) => Promise<void>;
  private readonly requireDesktop: boolean;
  private readonly initialRetryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly refillAfterClaim: boolean;
  private readonly protectedSandboxIds: () => Promise<ReadonlySet<string>>;
  private readonly logger: Pick<typeof console, "log" | "warn">;
  private readonly ready: SandboxHandle[] = [];
  private creating = 0;
  private failures = 0;
  private retryDelayMs = INITIAL_RETRY_DELAY_MS;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private reconciling = false;
  private started = false;

  constructor(options: CubeWarmPoolOptions) {
    this.name = options.name?.trim() || DEFAULT_CUBE_WARM_POOL_NAME;
    this.provider = options.provider;
    this.size = Math.max(0, Math.trunc(options.size));
    this.createOptions = withWarmPoolTemplateLabel(options.createOptions);
    this.warmDesktop = options.warmDesktop ?? ensureSandboxDesktopView;
    this.warmRuntime = options.warmRuntime ?? (async () => undefined);
    this.requireDesktop = options.requireDesktop ?? true;
    this.initialRetryDelayMs = Math.max(1, options.initialRetryDelayMs ?? INITIAL_RETRY_DELAY_MS);
    this.maxRetryDelayMs = Math.max(
      this.initialRetryDelayMs,
      options.maxRetryDelayMs ?? MAX_RETRY_DELAY_MS,
    );
    this.refillAfterClaim = options.refillAfterClaim ?? true;
    this.protectedSandboxIds = options.protectedSandboxIds ?? durablyBoundSandboxIds;
    this.retryDelayMs = this.initialRetryDelayMs;
    this.logger = options.logger ?? console;
  }

  start(): void {
    if (this.started || this.size <= 0) return;
    this.started = true;
    this.reconcileThenRefill();
  }

  stop(): void {
    this.started = false;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  async claim(): Promise<SandboxHandle | null> {
    if (!this.started) return null;
    while (this.started) {
      const candidate = this.ready.shift();
      if (!candidate) return null;

      let sandbox = candidate;
      try {
        // A pool entry can pause or be reclaimed after it was warmed. Re-resolve
        // the handle so Cube does not reuse an expired envd connection, then
        // prove command execution before assigning the sandbox to a run.
        sandbox = await this.provider.get(candidate.id);
        await sandbox.start();
        const probe = await sandbox.process.executeCommand(
          "true",
          undefined,
          undefined,
          CLAIM_PROBE_TIMEOUT_SECONDS,
        );
        if (probe.exitCode !== 0) throw new Error(`claim probe exited ${probe.exitCode}`);
        if (this.refillAfterClaim) this.refill();
        return sandbox;
      } catch (error) {
        this.failures += 1;
        this.logger.warn(
          `[cube-warm-pool:${this.name}] discarded stale ${candidate.id.slice(0, 8)}:`,
          error instanceof Error ? error.message : error,
        );
        try {
          await this.deleteResolvedCandidate(sandbox, candidate);
        } catch (deleteError) {
          this.failures += 1;
          this.logger.warn(
            `[cube-warm-pool:${this.name}] failed to delete discarded stale ${candidate.id.slice(0, 8)}:`,
            deleteError instanceof Error ? deleteError.message : deleteError,
          );
          this.scheduleRetry("reconcile");
          throw deleteError;
        }
        if (this.refillAfterClaim) this.refill();
        await this.waitForInFlightRefill();
      }
    }
    return null;
  }

  status(): CubeWarmPoolStatus {
    return {
      target: this.size,
      ready: this.ready.length,
      creating: this.creating,
      failures: this.failures,
      started: this.started,
    };
  }

  async dispose(): Promise<void> {
    this.stop();
    const candidates = this.ready.splice(0);
    await Promise.all(candidates.map((sandbox) => sandbox.delete()));
  }

  private refill(): void {
    if (this.reconciling) return;
    while (this.started && this.ready.length + this.creating < this.size) {
      this.creating += 1;
      void this.createOneAndContinue();
    }
  }

  private async createOneAndContinue(): Promise<void> {
    let failed = false;
    let retryMode: RetryMode = "refill";
    try {
      await this.createOne();
    } catch (error) {
      failed = true;
      if (error instanceof CleanupDeleteError) retryMode = "reconcile";
      this.failures += 1;
      this.logger.warn(
        `[cube-warm-pool:${this.name}] refill failed:`,
        error instanceof Error ? error.message : error,
      );
    } finally {
      this.creating -= 1;
    }
    if (failed) {
      this.scheduleRetry(retryMode);
      return;
    }
    this.retryDelayMs = this.initialRetryDelayMs;
    this.refill();
  }

  private scheduleRetry(mode: RetryMode): void {
    if (!this.started || this.retryTimer) return;
    const delay = this.retryDelayMs;
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, this.maxRetryDelayMs);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (mode === "reconcile") this.reconcileThenRefill();
      else this.refill();
    }, delay);
    this.retryTimer.unref?.();
  }

  private async waitForInFlightRefill(): Promise<void> {
    const deadline = Date.now() + 1_000;
    while (this.started && this.ready.length === 0 && this.creating > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  private async createOne(): Promise<void> {
    const sandbox = await this.provider.create(this.createOptions);
    try {
      await this.proveReady(sandbox);
      if (!this.started) {
        await this.deleteForCleanup(sandbox, "created sandbox after stop");
        return;
      }
      this.ready.push(sandbox);
      this.logger.log(
        `[cube-warm-pool:${this.name}] ready ${sandbox.id.slice(0, 8)} (${this.ready.length}/${this.size})`,
      );
    } catch (error) {
      if (!(error instanceof CleanupDeleteError)) {
        await this.deleteForCleanup(sandbox, "failed warmup sandbox");
      }
      throw error;
    }
  }

  private reconcileThenRefill(): void {
    if (this.reconciling) return;
    this.reconciling = true;
    void this.reconcileExistingAndRefill();
  }

  private async reconcileExistingAndRefill(): Promise<void> {
    let failed = false;
    try {
      await this.reconcileExisting();
    } catch (error) {
      failed = true;
      this.failures += 1;
      this.logger.warn(
        `[cube-warm-pool:${this.name}] startup reconcile failed:`,
        error instanceof Error ? error.message : error,
      );
    } finally {
      this.reconciling = false;
    }
    if (failed) {
      this.scheduleRetry("reconcile");
      return;
    }
    this.retryDelayMs = this.initialRetryDelayMs;
    this.refill();
  }

  private async reconcileExisting(): Promise<void> {
    this.failures += await reconcileCubeWarmPoolCandidates({
      name: this.name,
      provider: this.provider,
      createOptions: this.createOptions,
      ready: this.ready,
      size: this.size,
      isStarted: () => this.started,
      protectedSandboxIds: this.protectedSandboxIds,
      proveReady: (sandbox) => this.proveReady(sandbox),
      logger: this.logger,
    });
  }

  private async proveReady(sandbox: SandboxHandle): Promise<void> {
    const signal = AbortSignal.timeout(WARM_TIMEOUT_MS);
    if (this.requireDesktop) {
      const [desktop] = await Promise.all([
        this.warmDesktop(sandbox, signal),
        this.warmRuntime(sandbox, signal),
      ]);
      if (!desktop.available) {
        throw new Error(desktop.reason ?? "desktop computer-use surface unavailable");
      }
      return;
    }
    await this.warmRuntime(sandbox, signal);
  }

  private async deleteForCleanup(sandbox: SandboxHandle, context: string): Promise<void> {
    try {
      await sandbox.delete();
    } catch (error) {
      throw new CleanupDeleteError(`${context} delete failed`, error);
    }
  }

  private async deleteResolvedCandidate(
    sandbox: SandboxHandle,
    candidate: SandboxHandle,
  ): Promise<void> {
    try {
      await sandbox.delete();
    } catch (error) {
      if (sandbox.id !== candidate.id) await candidate.delete();
      throw new CleanupDeleteError(`discarded candidate delete failed`, error);
    }
  }
}

const activePools = new Map<string, CubeWarmPool>();

export function startCubeWarmPool(options: CubeWarmPoolOptions): CubeWarmPool {
  const pool = new CubeWarmPool(options);
  if (activePools.has(pool.name)) {
    throw new Error(`Cube warm pool ${pool.name} is already started`);
  }
  activePools.set(pool.name, pool);
  pool.start();
  return pool;
}

export async function claimCubeWarmSandbox(
  name = DEFAULT_CUBE_WARM_POOL_NAME,
): Promise<SandboxHandle | null> {
  return (await activePools.get(name)?.claim()) ?? null;
}

export function resetCubeWarmPoolForTest(): void {
  for (const pool of activePools.values()) pool.stop();
  activePools.clear();
}
