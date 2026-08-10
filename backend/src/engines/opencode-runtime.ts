/** Process-local cache for a thread's resident OpenCode control surface. The
 * durable thread→sandbox and thread→session mappings remain in Postgres; this
 * cache only avoids re-resolving preview endpoints during a live backend. */
export interface OpenCodeThreadServer {
  readonly sandboxId: string;
  readonly baseUrl: string;
  readonly token: string;
  readonly workdir: string;
}

const threadServers = new Map<string, OpenCodeThreadServer>();

export function getOpenCodeThreadServer(threadId: string): OpenCodeThreadServer | null {
  return threadServers.get(threadId) ?? null;
}

export function rememberOpenCodeThreadServer(
  threadId: string,
  server: OpenCodeThreadServer,
): void {
  threadServers.set(threadId, server);
}

export function forgetOpenCodeThreadServer(threadId: string): void {
  threadServers.delete(threadId);
}

export function getOpencodeThreadSandboxId(threadId: string): string | null {
  return threadServers.get(threadId)?.sandboxId ?? null;
}
