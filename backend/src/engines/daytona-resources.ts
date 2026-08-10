import type { Sandbox } from "@daytona/sdk";

export interface SandboxResourceTarget {
  cpu: number;
  memory: number;
}

const DEFAULT_CPU = 2;
const DEFAULT_MEMORY_GIB = 8;
const MAX_CPU = 128;
const MAX_MEMORY_GIB = 1024;

function positiveInteger(
  name: string,
  raw: string | undefined,
  fallback: number,
  maximum: number,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

/**
 * Resource policy for every user-facing Daytona engine. Snapshot-based creates
 * cannot accept per-create resources in the Daytona SDK, so maintained
 * snapshots carry this profile and callers verify it before booting a harness.
 */
export function resolveSandboxResourceTarget(
  env: Readonly<Record<string, string | undefined>> = process.env,
): SandboxResourceTarget {
  return {
    cpu: positiveInteger("SANDBOX_CPU", env.SANDBOX_CPU, DEFAULT_CPU, MAX_CPU),
    memory: positiveInteger(
      "SANDBOX_MEMORY_GIB",
      env.SANDBOX_MEMORY_GIB,
      DEFAULT_MEMORY_GIB,
      MAX_MEMORY_GIB,
    ),
  };
}

/**
 * Daytona's production API does not expose the SDK's hot-resize endpoint on
 * every account. Keep this check side-effect free: callers can discard a stale
 * retained box or reject a fresh provision before starting the agent.
 */
export function sandboxMeetsResourceTarget(
  sandbox: Sandbox,
  target = resolveSandboxResourceTarget(),
): boolean {
  return (
    Number.isFinite(sandbox.cpu) &&
    Number.isFinite(sandbox.memory) &&
    sandbox.cpu >= target.cpu &&
    sandbox.memory >= target.memory
  );
}

export function assertSandboxResources(
  sandbox: Sandbox,
  target = resolveSandboxResourceTarget(),
): SandboxResourceTarget {
  if (!sandboxMeetsResourceTarget(sandbox, target)) {
    throw new Error(
      `Daytona sandbox resources are below the required target (${target.cpu} CPU, ${target.memory} GiB RAM)`,
    );
  }
  return { cpu: sandbox.cpu, memory: sandbox.memory };
}
