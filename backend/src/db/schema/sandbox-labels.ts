import type { SandboxProviderKind } from "@useagent/sandbox-contract";
import { sql } from "drizzle-orm";
import { jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Labels the control plane attaches to a sandbox on providers without a
 * label API. Written only by the backend; the sandbox itself cannot reach
 * this table, which is what makes the labels trustworthy.
 */
export const sandboxLabels = pgTable(
  "sandbox_labels",
  {
    provider: text("provider").$type<SandboxProviderKind>().notNull(),
    sandboxId: text("sandbox_id").notNull(),
    labels: jsonb("labels").$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: "sandbox_labels_pk", columns: [t.provider, t.sandboxId] })],
);
