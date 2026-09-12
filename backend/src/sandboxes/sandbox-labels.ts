import type { SandboxLabelStore, SandboxProviderKind } from "@useagent/sandbox-contract";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/client";
import { sandboxLabels } from "../db/schema";

/**
 * The control plane's durable SandboxLabelStore (table sandbox_labels) for
 * providers without a label API of their own. Written only by the backend;
 * the sandbox itself cannot reach this table, which is what makes the labels
 * trustworthy.
 */
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
