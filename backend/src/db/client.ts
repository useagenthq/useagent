import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

// Single shared connection pool for the whole process. Its connections name
// the zone this process's clock runs in, which a migration applied here reads
// (drizzle/0114_schedule_zones.sql): the backend migrates at boot and the
// release script runs under the backend's own env, so it is the clock the
// backend reads local times in.
export const client = postgres(
  process.env.DATABASE_URL ?? "postgres://postgres@localhost:5432/useagent",
  { max: 10, connection: { "useagent.backend_time_zone": Intl.DateTimeFormat().resolvedOptions().timeZone } },
);
export const db = drizzle(client, { schema });

export type Db = typeof db;
/** The transaction handle drizzle hands the `db.transaction` callback. */
export type DbTx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Either the pool or an open transaction — lets a repo write participate in a
 *  caller's transaction (durable-command acceptance) or run standalone. */
export type Executor = Db | DbTx;
