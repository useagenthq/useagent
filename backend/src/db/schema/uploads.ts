import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { runs } from "./runs";

// ---------------------------------------------------------------------------
// User-provided run inputs. Bytes reuse the content-addressed ArtifactStorage
// boundary, but uploads have their own lifecycle because they exist before a
// run. A ready upload is atomically claimed by exactly one run during durable
// command acceptance; ownership never comes from a prompt or sandbox.
// ---------------------------------------------------------------------------

export const userUploads = pgTable(
  "user_uploads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    runId: text("run_id").references(() => runs.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    storageKey: text("storage_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("idx_user_uploads_owner_created").on(t.orgId, t.userId, t.createdAt),
    index("idx_user_uploads_run").on(t.runId),
    index("idx_user_uploads_expires").on(t.expiresAt),
  ],
);
