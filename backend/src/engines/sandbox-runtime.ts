import type { Sandbox } from "@daytona/sdk";

/**
 * Process-local handles for sandboxes already resolved by this backend.
 *
 * Postgres remains the durable thread-to-sandbox source of truth. This registry
 * only avoids another Daytona control-plane lookup while the same backend still
 * owns a live SDK object. A restart naturally empties it and falls back to the
 * durable mapping.
 */
const liveThreadSandboxes = new Map<string, Sandbox>();

export function getLiveThreadSandbox(threadId: string): Sandbox | null {
  return liveThreadSandboxes.get(threadId) ?? null;
}

export function rememberLiveThreadSandbox(threadId: string, sandbox: Sandbox): void {
  liveThreadSandboxes.set(threadId, sandbox);
}

/**
 * Remove a handle only when it still points at the sandbox being cleaned up.
 * The optional id prevents an older run's finally block from evicting a newer
 * sandbox that has already replaced it for the same thread.
 */
export function forgetLiveThreadSandbox(threadId: string, sandboxId?: string): void {
  if (sandboxId && liveThreadSandboxes.get(threadId)?.id !== sandboxId) return;
  liveThreadSandboxes.delete(threadId);
}
