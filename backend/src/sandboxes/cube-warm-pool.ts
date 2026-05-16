import { ensureSandboxDesktopView, type SandboxDesktop } from "../engines/desktop";
import type { SandboxCreateOptions, SandboxHandle, SandboxProvider } from "./provider";

const CUBE_WARM_POOL_SIZE_ENV = "CUBE_WARM_POOL_SIZE";
const CUBE_T3_WARM_POOL_SIZE_ENV = "CUBE_T3_WARM_POOL_SIZE";
export const DEFAULT_CUBE_WARM_POOL_NAME = "default";
const WARM_TIMEOUT_MS = 120_000;
const CLAIM_PROBE_TIMEOUT_SECONDS = 5;
const INITIAL_RETRY_DELAY_MS = 2_000;
const MAX_RETRY_DELAY_MS = 60_000;

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

export function cubeT3WarmPoolSize(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number | null {
  return configuredPoolSize(CUBE_T3_WARM_POOL_SIZE_ENV, env);
}

export interface CubeWarmPoolOptions {
  readonly name?: string;
  readonly provider: SandboxProvider;
  readonly size: number;
  readonly createOptions: SandboxCreateOptions;
  readonly warmDesktop?: (sandbox: SandboxHandle, signal: AbortSignal) => Promise<SandboxDesktop>;
  readonly warmRuntime?: (sandbox: SandboxHandle, signal: AbortSignal) => Promise<void>;
  readonly initialRetryDelayMs?: number;
  readonly maxRetryDelayMs?: number;
  readonly refillAfterClaim?: boolean;
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
  private readonly initialRetryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly refillAfterClaim: boolean;
  private readonly logger: Pick<typeof console, "log" | "warn">;
  private readonly ready: SandboxHandle[] = [];
  private creating = 0;
  private failures = 0;
  private retryDelayMs = INITIAL_RETRY_DELAY_MS;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;

  constructor(options: CubeWarmPoolOptions) {
    this.name = options.name?.trim() || DEFAULT_CUBE_WARM_POOL_NAME;
    this.provider = options.provider;
    this.size = Math.max(0, Math.trunc(options.size));
    this.createOptions = options.createOptions;
    this.warmDesktop = options.warmDesktop ?? ensureSandboxDesktopView;
    this.warmRuntime = options.warmRuntime ?? (async () => undefined);
    this.initialRetryDelayMs = Math.max(1, options.initialRetryDelayMs ?? INITIAL_RETRY_DELAY_MS);
    this.maxRetryDelayMs = Math.max(
      this.initialRetryDelayMs,
      options.maxRetryDelayMs ?? MAX_RETRY_DELAY_MS,
    );
    this.refillAfterClaim = options.refillAfterClaim ?? true;
    this.retryDelayMs = this.initialRetryDelayMs;
    this.logger = options.logger ?? console;
  }

  start(): void {
    if (this.started || this.size <= 0) return;
    this.started = true;
    this.refill();
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
      if (this.refillAfterClaim) this.refill();

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
        return sandbox;
      } catch (error) {
        this.failures += 1;
        this.logger.warn(
          `[cube-warm-pool:${this.name}] discarded stale ${candidate.id.slice(0, 8)}:`,
          error instanceof Error ? error.message : error,
        );
        await sandbox.delete().catch(() => candidate.delete().catch(() => {}));
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
    await Promise.all(candidates.map((sandbox) => sandbox.delete().catch(() => {})));
  }

  private refill(): void {
    while (this.started && this.ready.length + this.creating < this.size) {
      this.creating += 1;
      let failed = false;
      void this.createOne()
        .catch((error) => {
          failed = true;
          this.failures += 1;
          this.logger.warn(
            `[cube-warm-pool:${this.name}] refill failed:`,
            error instanceof Error ? error.message : error,
          );
        })
        .finally(() => {
          this.creating -= 1;
          if (failed) {
            this.scheduleRetry();
            return;
          }
          this.retryDelayMs = this.initialRetryDelayMs;
          this.refill();
        });
    }
  }

  private scheduleRetry(): void {
    if (!this.started || this.retryTimer) return;
    const delay = this.retryDelayMs;
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, this.maxRetryDelayMs);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.refill();
    }, delay);
    this.retryTimer.unref?.();
  }

  private async createOne(): Promise<void> {
    const sandbox = await this.provider.create(this.createOptions);
    try {
      const signal = AbortSignal.timeout(WARM_TIMEOUT_MS);
      const [desktop] = await Promise.all([
        this.warmDesktop(sandbox, signal),
        this.warmRuntime(sandbox, signal),
      ]);
      if (!desktop.available) {
        throw new Error(desktop.reason ?? "desktop computer-use surface unavailable");
      }
      this.ready.push(sandbox);
      this.logger.log(
        `[cube-warm-pool:${this.name}] ready ${sandbox.id.slice(0, 8)} (${this.ready.length}/${this.size})`,
      );
    } catch (error) {
      await sandbox.delete().catch(() => {});
      throw error;
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
