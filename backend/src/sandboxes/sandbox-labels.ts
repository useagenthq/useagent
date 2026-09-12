import type { SandboxProviderKind } from "@useagent/sandbox-contract";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/client";
import { sandboxLabels } from "../db/schema";

/**
 * Control-plane labels for providers that have no label API of their own
 * (Box). Labels are the credential-generation and run-attribution trust
 * anchor, so they live here - never inside the sandbox where the agent
 * could rewrite them.
 */
export interface SandboxLabelStore {
  read(sandboxIds: readonly string[]): Promise<Map<string, Record<string, string>>>;
  write(sandboxId: string, labels: Record<string, string>): Promise<void>;
  remove(sandboxId: string): Promise<void>;
}

export function dbSandboxLabelStore(provider: SandboxProviderKind): SandboxLabelStore {
  return {
    async read(sandboxIds) {
      if (sandboxIds.length === 0) return new Map();
      const rows = await db
        .select({ sandboxId: sandboxLabels.sandboxId, labels: sandboxLabels.labels })
        .from(sandboxLabels)
        .where(and(eq(sandboxLabels.provider, provider), inArray(sandboxLabels.sandboxId, [...sandboxIds])));
      return new Map(rows.map((row) => [row.sandboxId, row.labels]));
    },
    async write(sandboxId, labels) {
      await db
        .insert(sandboxLabels)
        .values({ provider, sandboxId, labels })
        .onConflictDoUpdate({ target: [sandboxLabels.provider, sandboxLabels.sandboxId], set: { labels, updatedAt: new Date() } });
    },
    async remove(sandboxId) {
      await db.delete(sandboxLabels).where(and(eq(sandboxLabels.provider, provider), eq(sandboxLabels.sandboxId, sandboxId)));
    },
  };
}

/** Process-local store for tests and dry runs. */
export function memorySandboxLabelStore(): SandboxLabelStore {
  const store = new Map<string, Record<string, string>>();
  return {
    async read(sandboxIds) {
      return new Map(sandboxIds.flatMap((id) => (store.has(id) ? [[id, store.get(id)!] as const] : [])));
    },
    async write(sandboxId, labels) {
      store.set(sandboxId, { ...labels });
    },
    async remove(sandboxId) {
      store.delete(sandboxId);
    },
  };
}
