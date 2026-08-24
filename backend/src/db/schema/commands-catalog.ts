import { sql } from "drizzle-orm";
import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Slash-command catalog cache. The engine's real command list (opencode's GET
// /command) is IDENTICAL for every fresh sandbox of a given snapshot, so it is
// cached ONCE per snapshot name rather than re-fetched per thread. The
// live-proxy upserts this row whenever a live sandbox answers /command; the New
// Task composer reads it (via GET /api/commands) to power "/" autocomplete
// BEFORE any sandbox exists. Single row per snapshot — a tiny keyed cache, not
// event-sourced state.
// ---------------------------------------------------------------------------

/** One entry in a command catalog, normalized across engines (opencode's /command
 *  and ACP's available_commands_update). `input` is an optional argument hint. Stored
 *  in jsonb, so the optional field is additive with NO migration. */
export interface CatalogCommand {
  name: string;
  description: string | null;
  input?: string | null;
}

export const commandsCatalog = pgTable("commands_catalog", {
  /** The Daytona snapshot the catalog was fetched from (DAYTONA_SNAPSHOT). */
  snapshot: text("snapshot").primaryKey(),
  commands: jsonb("commands")
    .$type<CatalogCommand[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
});
