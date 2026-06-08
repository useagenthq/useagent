import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/** One product-owned fan-out request. Idempotency is tenant-scoped and the
 * caller's key is stored only as a SHA-256 digest. */
export const fleetBatches = pgTable(
  "fleet_batches",
  {
    id: uuid("id").notNull().defaultRandom(),
    orgId: text("org_id").notNull(),
    actorId: text("actor_id").notNull(),
    idempotencyKeyHash: text("idempotency_key_hash").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    itemCount: integer("item_count").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.id], name: "fleet_batches_org_id_id_pk" }),
    check(
      "fleet_batches_idempotency_hash_check",
      sql`${t.idempotencyKeyHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "fleet_batches_request_fingerprint_check",
      sql`${t.requestFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    check("fleet_batches_item_count_check", sql`${t.itemCount} BETWEEN 1 AND 20`),
    uniqueIndex("uq_fleet_batches_org_idempotency").on(t.orgId, t.idempotencyKeyHash),
    index("idx_fleet_batches_org_created").on(t.orgId, t.createdAt, t.id),
  ],
);

/** Ordered membership of accepted runs in a batch. The composite batch FK
 * prevents a run association from crossing tenant boundaries. */
export const fleetBatchRuns = pgTable(
  "fleet_batch_runs",
  {
    orgId: text("org_id").notNull(),
    batchId: uuid("batch_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    // Immutable manifest identity. Membership intentionally outlives run
    // deletion so idempotent replay remains complete and reports a tombstone.
    runId: text("run_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      columns: [t.orgId, t.batchId, t.ordinal],
      name: "fleet_batch_runs_org_batch_ordinal_pk",
    }),
    check("fleet_batch_runs_ordinal_check", sql`${t.ordinal} BETWEEN 0 AND 19`),
    foreignKey({
      name: "fk_fleet_batch_runs_batch",
      columns: [t.orgId, t.batchId],
      foreignColumns: [fleetBatches.orgId, fleetBatches.id],
    }).onDelete("cascade"),
    uniqueIndex("uq_fleet_batch_runs_org_run").on(t.orgId, t.runId),
    index("idx_fleet_batch_runs_org_batch").on(t.orgId, t.batchId, t.ordinal),
  ],
);

export type FleetBatchRow = typeof fleetBatches.$inferSelect;
export type FleetBatchRunRow = typeof fleetBatchRuns.$inferSelect;
