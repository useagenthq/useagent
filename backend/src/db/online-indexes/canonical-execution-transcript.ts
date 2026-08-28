import postgres from "postgres";

export const CANONICAL_EXECUTION_TRANSCRIPT_INDEX =
  "idx_canonical_events_execution_delivery_v1";
export const CANONICAL_EXECUTION_TRANSCRIPT_TABLE = "canonical_events";
export const CANONICAL_EXECUTION_TRANSCRIPT_SCHEMA = "public";

const INDEX_LOCK_KEY = 0x5541_4345; // "UACE"
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 300_000;

export const CANONICAL_EXECUTION_TRANSCRIPT_INDEX_SQL = `
  CREATE INDEX CONCURRENTLY ${CANONICAL_EXECUTION_TRANSCRIPT_INDEX}
  ON ${CANONICAL_EXECUTION_TRANSCRIPT_SCHEMA}.${CANONICAL_EXECUTION_TRANSCRIPT_TABLE}
  (run_id, (identity ->> 'provider'), (identity ->> 'nativeSessionId'), delivery_seq)
`;

const DROP_INDEX_SQL = `DROP INDEX CONCURRENTLY IF EXISTS ${CANONICAL_EXECUTION_TRANSCRIPT_SCHEMA}.${CANONICAL_EXECUTION_TRANSCRIPT_INDEX}`;

export type CanonicalExecutionIndexState =
  | { readonly kind: "absent" }
  | { readonly kind: "exact-valid" }
  | { readonly kind: "invalid-residue"; readonly detail: string }
  | { readonly kind: "valid-mismatch"; readonly detail: string };

export interface CanonicalExecutionIndexCatalogRow {
  readonly schema_name: string;
  readonly table_name: string;
  readonly index_name: string;
  readonly access_method: string;
  readonly predicate: string | null;
  readonly total_attributes: number;
  readonly key_attributes: number;
  readonly is_unique: boolean;
  readonly is_valid: boolean;
  readonly is_ready: boolean;
  readonly is_live: boolean;
  readonly key_expressions: string[];
}

const EXPECTED_KEYS = [
  "run_id",
  "identity ->> 'provider'::text",
  "identity ->> 'nativeSessionId'::text",
  "delivery_seq",
] as const;

function normalizeKeyExpression(value: string): string {
  let normalized = value.trim().replaceAll(/\s+/g, " ");
  while (normalized.startsWith("(") && normalized.endsWith(")")) {
    normalized = normalized.slice(1, -1).trim();
  }
  return normalized.replaceAll(/\((identity ->> '[^']+'::text)\)/g, "$1");
}

export function classifyCanonicalExecutionIndex(
  rows: readonly CanonicalExecutionIndexCatalogRow[],
): CanonicalExecutionIndexState {
  if (rows.length === 0) return { kind: "absent" };
  if (rows.length !== 1) {
    return { kind: "valid-mismatch", detail: `expected one catalog row, found ${rows.length}` };
  }

  const row = rows[0]!;
  const keys = row.key_expressions.map(normalizeKeyExpression);
  const exactIdentity =
    row.schema_name === CANONICAL_EXECUTION_TRANSCRIPT_SCHEMA &&
    row.table_name === CANONICAL_EXECUTION_TRANSCRIPT_TABLE &&
    row.index_name === CANONICAL_EXECUTION_TRANSCRIPT_INDEX;
  const exactKeys =
    keys.length === EXPECTED_KEYS.length &&
    keys.every((key, index) => key === EXPECTED_KEYS[index]);
  const exactDefinition =
    exactIdentity &&
    exactKeys &&
    row.access_method === "btree" &&
    row.predicate === null &&
    row.total_attributes === row.key_attributes &&
    row.key_attributes === EXPECTED_KEYS.length &&
    row.is_unique === false;
  const fullyValid = row.is_valid && row.is_ready && row.is_live;

  if (exactDefinition && fullyValid) return { kind: "exact-valid" };
  const detail = JSON.stringify({
    schema: row.schema_name,
    table: row.table_name,
    index: row.index_name,
    accessMethod: row.access_method,
    predicate: row.predicate,
    totalAttributes: row.total_attributes,
    keyAttributes: row.key_attributes,
    unique: row.is_unique,
    keys,
    valid: row.is_valid,
    ready: row.is_ready,
    live: row.is_live,
  });
  // Only an invalid copy of OUR exact definition is safe to replace. A same-name
  // index on another table or with different keys is never ours to destroy.
  return exactDefinition
    ? { kind: "invalid-residue", detail }
    : { kind: "valid-mismatch", detail };
}

interface IndexConnection {
  unsafe(query: string): Promise<unknown>;
  <T extends readonly (object | undefined)[] = object[]>(
    strings: TemplateStringsArray,
    ...values: readonly unknown[]
  ): Promise<T>;
}

interface ReservedIndexConnection extends IndexConnection {
  release(): void;
}

interface IndexClient {
  reserve(): Promise<ReservedIndexConnection>;
  end(): Promise<void>;
}

function releaseReserved(connection: ReservedIndexConnection): void {
  try {
    connection.release();
  } catch {
    // Connection finalization must not mask the maintenance result/error.
  }
}

export interface CanonicalExecutionIndexOptions {
  readonly databaseUrl?: string;
  readonly connect?: (url: string, options: { max: number }) => IndexClient;
  readonly lockTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
}

function boundedMs(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > 3_600_000) {
    throw new Error(`${name} must be an integer from 1 to 3600000 milliseconds`);
  }
  return result;
}

function envTimeout(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

async function readCatalog(
  connection: IndexConnection,
): Promise<CanonicalExecutionIndexCatalogRow[]> {
  return await connection<CanonicalExecutionIndexCatalogRow[]>`
    SELECT
      ns.nspname AS schema_name,
      tbl.relname AS table_name,
      idx.relname AS index_name,
      am.amname AS access_method,
      pg_get_expr(pi.indpred, pi.indrelid) AS predicate,
      pi.indnatts AS total_attributes,
      pi.indnkeyatts AS key_attributes,
      pi.indisunique AS is_unique,
      pi.indisvalid AS is_valid,
      pi.indisready AS is_ready,
      pi.indislive AS is_live,
      ARRAY(
        SELECT pg_get_indexdef(pi.indexrelid, key_position, true)
        FROM generate_series(1, pi.indnkeyatts) AS key_position
        ORDER BY key_position
      ) AS key_expressions
    FROM pg_index pi
    JOIN pg_class idx ON idx.oid = pi.indexrelid
    JOIN pg_class tbl ON tbl.oid = pi.indrelid
    JOIN pg_namespace ns ON ns.oid = idx.relnamespace
    JOIN pg_am am ON am.oid = idx.relam
    WHERE ns.nspname = ${CANONICAL_EXECUTION_TRANSCRIPT_SCHEMA}
      AND idx.relname = ${CANONICAL_EXECUTION_TRANSCRIPT_INDEX}
  `;
}

async function configureSession(
  connection: IndexConnection,
  options: CanonicalExecutionIndexOptions,
): Promise<void> {
  const lockTimeoutMs = boundedMs(
    options.lockTimeoutMs ?? envTimeout("CANONICAL_EXECUTION_INDEX_LOCK_TIMEOUT_MS"),
    DEFAULT_LOCK_TIMEOUT_MS,
    "lock timeout",
  );
  const statementTimeoutMs = boundedMs(
    options.statementTimeoutMs ?? envTimeout("CANONICAL_EXECUTION_INDEX_STATEMENT_TIMEOUT_MS"),
    DEFAULT_STATEMENT_TIMEOUT_MS,
    "statement timeout",
  );
  await connection.unsafe(`SET lock_timeout = '${lockTimeoutMs}ms'`);
  await connection.unsafe(`SET statement_timeout = '${statementTimeoutMs}ms'`);
}

async function withLockedConnection<T>(
  options: CanonicalExecutionIndexOptions,
  operation: (connection: ReservedIndexConnection) => Promise<T>,
): Promise<T> {
  const databaseUrl =
    options.databaseUrl ??
    process.env.DATABASE_URL ??
    "postgres://postgres@localhost:5432/useagent";
  const connect = options.connect ?? ((url, config) => postgres(url, config) as IndexClient);
  const client = connect(databaseUrl, { max: 1 });
  let reserved: ReservedIndexConnection | null = null;
  let locked = false;
  try {
    reserved = await client.reserve();
    await configureSession(reserved, options);
    const [row] = await reserved<{ locked: boolean }[]>`
      SELECT pg_try_advisory_lock(${INDEX_LOCK_KEY}) AS locked
    `;
    if (row?.locked !== true) {
      throw new Error("canonical execution transcript index maintenance is already running");
    }
    locked = true;
    return await operation(reserved);
  } finally {
    if (reserved) {
      if (locked) {
        await reserved`SELECT pg_advisory_unlock(${INDEX_LOCK_KEY})`.catch(() => {});
      }
      releaseReserved(reserved);
    }
    await client.end().catch(() => {});
  }
}

export async function inspectCanonicalExecutionTranscriptIndex(
  connection: IndexConnection,
): Promise<CanonicalExecutionIndexState> {
  return classifyCanonicalExecutionIndex(await readCatalog(connection));
}

export async function applyCanonicalExecutionTranscriptIndex(
  options: CanonicalExecutionIndexOptions = {},
): Promise<CanonicalExecutionIndexState> {
  return await withLockedConnection(options, async (connection) => {
    const current = await inspectCanonicalExecutionTranscriptIndex(connection);
    if (current.kind === "exact-valid") return current;
    if (current.kind === "valid-mismatch") {
      throw new Error(`canonical execution transcript index definition mismatch: ${current.detail}`);
    }
    if (current.kind === "invalid-residue") await connection.unsafe(DROP_INDEX_SQL);
    await connection.unsafe(CANONICAL_EXECUTION_TRANSCRIPT_INDEX_SQL);
    const applied = await inspectCanonicalExecutionTranscriptIndex(connection);
    if (applied.kind !== "exact-valid") {
      throw new Error(`canonical execution transcript index apply verification failed: ${JSON.stringify(applied)}`);
    }
    return applied;
  });
}

export async function verifyCanonicalExecutionTranscriptIndex(
  options: CanonicalExecutionIndexOptions = {},
): Promise<void> {
  const databaseUrl =
    options.databaseUrl ??
    process.env.DATABASE_URL ??
    "postgres://postgres@localhost:5432/useagent";
  const connect = options.connect ?? ((url, config) => postgres(url, config) as IndexClient);
  const client = connect(databaseUrl, { max: 1 });
  let reserved: ReservedIndexConnection | null = null;
  try {
    reserved = await client.reserve();
    await configureSession(reserved, options);
    const state = await inspectCanonicalExecutionTranscriptIndex(reserved);
    if (state.kind !== "exact-valid") {
      throw new Error(`canonical execution transcript index is not ready: ${JSON.stringify(state)}`);
    }
  } finally {
    if (reserved) releaseReserved(reserved);
    await client.end().catch(() => {});
  }
}

export async function dropCanonicalExecutionTranscriptIndex(
  options: CanonicalExecutionIndexOptions = {},
): Promise<void> {
  await withLockedConnection(options, async (connection) => {
    const current = await inspectCanonicalExecutionTranscriptIndex(connection);
    if (current.kind === "valid-mismatch") {
      throw new Error(`refusing to drop mismatched canonical execution index: ${current.detail}`);
    }
    await connection.unsafe(DROP_INDEX_SQL);
    const dropped = await inspectCanonicalExecutionTranscriptIndex(connection);
    if (dropped.kind !== "absent") {
      throw new Error(`canonical execution transcript index drop verification failed: ${JSON.stringify(dropped)}`);
    }
  });
}

export async function assertCanonicalExecutionTranscriptIndexForBoot(
  environment: Record<string, string | undefined> = process.env,
  verify: () => Promise<void> = () => verifyCanonicalExecutionTranscriptIndex(),
): Promise<void> {
  if (environment.EXECUTION_GRAPH_ROLLOUT?.trim().toLowerCase() !== "read") return;
  await verify();
}
