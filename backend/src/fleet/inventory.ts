import type { SandboxInventory } from "@useagent/sandbox-contract";
import { db, type Executor } from "../db/client";
import {
  sandboxProvider,
  sandboxProviderApiKey,
  sandboxProviderKind,
} from "../sandboxes/provider";
import { reservationSnapshot } from "./lease-repo";
import type { CapacityInventory } from "./types";

// ---------------------------------------------------------------------------
// Capacity inventory assembly. The authoritative numbers (active count +
// reserved cpu/memory, global and per-org) come from the durable sandbox_leases
// table. Provider telemetry (multi-node allocatable headroom) is OPTIONAL, read
// from the sandbox contract's `inventory()` method, and cached so it is NEVER
// awaited on the admission path — provider listing is slow and latency-variable.
// A missing/failed provider snapshot simply drops the provider ceiling; the
// declared-host budget in the policy still governs.
// ---------------------------------------------------------------------------

let providerCache: { at: number; inv: SandboxInventory } | null = null;
let refreshing: Promise<void> | null = null;
const PROVIDER_TTL_MS = 30_000;

async function refreshProviderInventory(): Promise<void> {
  const apiKey = sandboxProviderApiKey();
  if (apiKey === undefined) return;
  const provider = sandboxProvider(apiKey);
  if (typeof provider.inventory !== "function") return;
  const inv = await provider.inventory();
  providerCache = { at: Date.now(), inv };
}

/** Kick a non-blocking provider-inventory refresh if the cache is stale. At most
 *  one refresh is in flight; failures are logged, never surfaced. */
export function ensureProviderInventory(): void {
  const stale = !providerCache || Date.now() - providerCache.at > PROVIDER_TTL_MS;
  if (stale && !refreshing) {
    refreshing = refreshProviderInventory()
      .catch((err) =>
        console.warn(
          "[fleet] provider inventory refresh failed:",
          err instanceof Error ? err.message : err,
        ),
      )
      .finally(() => {
        refreshing = null;
      });
  }
}

/** The last cached provider inventory (or null). Kicks a background refresh. */
export function cachedProviderInventory(): SandboxInventory | null {
  ensureProviderInventory();
  return providerCache?.inv ?? null;
}

/** For tests: install a provider inventory snapshot directly (bypasses the live
 *  provider). Passing null clears it. */
export function setProviderInventoryForTest(inv: SandboxInventory | null): void {
  providerCache = inv ? { at: Date.now(), inv } : null;
}

/** Assemble the policy's inventory: durable lease reservations + the optional
 *  cached provider ceiling. Runs inside the admission transaction via `exec`. */
export async function buildCapacityInventory(
  orgId: string,
  exec: Executor = db,
  excludeRetainedSandboxId?: string | null,
): Promise<CapacityInventory> {
  const res = await reservationSnapshot(orgId, exec, excludeRetainedSandboxId);
  const prov = providerCache?.inv ?? null;
  const resident = Math.max(0, Math.max(
    (prov?.activeSandboxes ?? 0) + (prov?.pausedSandboxes ?? 0),
    prov?.warmPoolReady ?? 0,
  ) - (excludeRetainedSandboxId ? 1 : 0));
  return {
    globalActiveSandboxes: Math.max(res.globalActiveSandboxes, resident),
    globalReservedCpuMillicores: res.globalReservedCpuMillicores,
    globalReservedMemoryMib: res.globalReservedMemoryMib,
    orgActiveSandboxes: res.orgActiveSandboxes,
    providerAllocatableCpuMillicores: prov?.allocatableCpuMillicores,
    providerAllocatableMemoryMib: prov?.allocatableMemoryMib,
    providerReadyNodes: prov?.readyNodes,
    providerNodes: prov?.nodes,
  };
}

/** The active provider kind label persisted on leases. */
export function activeProviderLabel(): string {
  return sandboxProviderKind();
}
