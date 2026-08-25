import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { runs } from "./runs";

// ---------------------------------------------------------------------------
// Fleet capacity + admission (HA Stage A). Two durable tables that make workload
// admission a first-class, restart-safe fact SEPARATE from sandbox creation:
//
//   run_admissions — one row per accepted run. Records the requested resource
//     class (engine/model + declared cpu/memory + tier), priority, and the
//     capacity lifecycle state (queued -> leased -> running -> terminal). The
//     queue_reason explains WHY a run is still queued (global/org limit or
//     provider capacity). This row is inserted ATOMICALLY with the run + command
//     (commands/repo.ts), so a queued task survives a crash exactly like a run.
//
//   sandbox_leases — one row per granted capacity reservation. A lease reserves
//     DECLARED cpu/memory against the host/provider budget (never measured RAM),
//     binds to a run/thread/sandbox, and carries a heartbeat + expiry. A crashed
//     worker's lease expires and is reconciled against the provider so capacity
//     is reclaimed rather than leaked.
//
// Single-backend scope (Stage A): the capacity DECISION is serialized by a
// Postgres advisory lock and every count/claim is transactional, so the queue +
// lease semantics do NOT depend on any process-local map. See
// docs/architecture/fleet-capacity-admission.md for the state machine + the
// process-local blockers that still gate multiple active backends.
// ---------------------------------------------------------------------------

/** Capacity lifecycle of an accepted run. `queued` waits for capacity; `leased`
 *  holds a reservation (actor spawned); `running` mirrors the run going live;
 *  the terminal three mirror the run's settle. */
export type AdmissionState =
  | "queued"
  | "leased"
  | "running"
  | "completed"
  | "failed"
  | "canceled";

/** Why a run is still queued. `null` once admitted. */
export type QueueReason =
  | "global_limit"
  | "org_limit"
  | "provider_capacity"
  | "invalid_request"
  | "lease_expired";

/** Workload tier — a named resource class. `standard` is the default agent box;
 *  `desktop` is the larger VNC/desktop box. */
export type WorkloadTier = "standard" | "desktop";

export const runAdmissions = pgTable(
  "run_admissions",
  {
    /** The accepted run. PK ⇒ one admission per run; insert is idempotent-safe. */
    runId: text("run_id")
      .primaryKey()
      .references(() => runs.id, { onDelete: "cascade" }),
    orgId: text("org_id").notNull(),
    /** The run's conversation thread — the reconciler pumps by thread, and
     *  per-thread serialization means one active run per thread. */
    threadId: text("thread_id").notNull(),
    engine: text("engine").notNull(),
    model: text("model").notNull(),
    /** Named resource class (standard | desktop). */
    tier: text("tier").$type<WorkloadTier>().notNull().default("standard"),
    /** DECLARED reservation for this run's sandbox — the reservation math uses
     *  these, never currently-resident RAM. */
    cpuMillicores: integer("cpu_millicores").notNull(),
    memoryMib: integer("memory_mib").notNull(),
    /** Higher dispatches sooner. Default 0. */
    priority: integer("priority").notNull().default(0),
    state: text("state").$type<AdmissionState>().notNull().default("queued"),
    /** Null once admitted; otherwise the branch that kept it queued. */
    queueReason: text("queue_reason").$type<QueueReason>(),
    retryCount: integer("retry_count").notNull().default(0),
    /** The active lease that admitted this run (sandbox_leases.id), or null. */
    workerLeaseId: text("worker_lease_id"),
    queuedAt: timestamp("queued_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    admittedAt: timestamp("admitted_at", { withTimezone: true }),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // The admit scan claims the highest-priority, oldest queued rows.
    index("idx_run_admissions_state_priority").on(
      t.state,
      t.priority,
      t.queuedAt,
    ),
    index("idx_run_admissions_capacity_queue")
      .on(t.state, t.priority.desc(), t.queuedAt.asc(), t.runId.asc())
      .where(sql`${t.state} = 'queued' and ${t.queueReason} in ('provider_capacity', 'global_limit', 'org_limit')`),
    // Per-org active counts + durable queue-depth ceiling.
    index("idx_run_admissions_org_state").on(t.orgId, t.state),
  ],
);

export const sandboxLeases = pgTable(
  "sandbox_leases",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    threadId: text("thread_id").notNull(),
    orgId: text("org_id").notNull(),
    /** cube | daytona | mock — the provider that owns the sandbox. */
    provider: text("provider").notNull(),
    /** Compute node/host when the provider exposes one (Cube multi-node); null
     *  for single-node providers. */
    node: text("node"),
    /** The provisioned sandbox id, backfilled from the run once its box exists. */
    sandboxId: text("sandbox_id"),
    reservedCpuMillicores: integer("reserved_cpu_millicores").notNull(),
    reservedMemoryMib: integer("reserved_memory_mib").notNull(),
    tier: text("tier").$type<WorkloadTier>().notNull().default("standard"),
    /** active and reclaiming hold capacity; released does not. */
    state: text("state")
      .$type<"active" | "reclaiming" | "released">()
      .notNull()
      .default("active"),
    gcAttemptCount: integer("gc_attempt_count").notNull().default(0),
    nextGcAttemptAt: timestamp("next_gc_attempt_at", { withTimezone: true }),
    gcLastError: text("gc_last_error"),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    leaseExpiry: timestamp("lease_expiry", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // The reconciler claims due-expired active leases by this index.
    index("idx_sandbox_leases_state_expiry").on(t.state, t.leaseExpiry),
    index("idx_sandbox_leases_state_gc_retry").on(t.state, t.nextGcAttemptAt),
    // Per-org + global active reservation sums.
    index("idx_sandbox_leases_org_state").on(t.orgId, t.state),
    index("idx_sandbox_leases_run").on(t.runId),
    // At most ONE capacity-holding lease per run (double-admission guard).
    uniqueIndex("uq_sandbox_leases_active_run")
      .on(t.runId)
      .where(sql`state in ('active', 'reclaiming')`),
  ],
);

export type RunAdmissionRow = typeof runAdmissions.$inferSelect;
export type SandboxLeaseRow = typeof sandboxLeases.$inferSelect;
