import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../env";
import * as schema from "./schema";

// Single shared connection pool for the whole process.
export const client = postgres(env.DATABASE_URL, { max: 10 });
export const db = drizzle(client, { schema });

export type Db = typeof db;
/** The transaction handle drizzle hands the `db.transaction` callback. */
export type DbTx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Either the pool or an open transaction — lets a repo write participate in a
 *  caller's transaction (durable-command acceptance) or run standalone. */
export type Executor = Db | DbTx;
