import { and, eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { db } from "../db/client";
import { commands } from "../db/schema";

const BOT_HANDOFF_ATTEMPT = "bot.handoff.attempt";
/** How long a handoff waits for its admission locks before reporting busy. */
const HANDOFF_LOCK_WAIT_MS = 15_000;
const LOCK_TIMEOUT_SQLSTATE = "55P03";

let handoffLockClient: ReturnType<typeof postgres> | null = null;

export class HandoffLockTimeout extends Error {}

export interface BotHandoffAttempt {
  readonly orgId: string;
  readonly actorId: string | null;
  readonly parentRunId: string;
  readonly threadId: string;
  readonly botId: string;
  readonly maxAttempts: number;
}

function botHandoffLockClient(): ReturnType<typeof postgres> {
  handoffLockClient ??= postgres(
    process.env.DATABASE_URL ?? "postgres://postgres@localhost:5432/useagent",
    // One connection per in-flight handoff; a five-bot message plus live-turn tool calls
    // must not queue behind two.
    { max: 8 },
  );
  return handoffLockClient;
}

export async function withBotHandoffLocks<T>(
  lockKeys: readonly string[],
  operation: () => Promise<T>,
): Promise<T> {
  let result!: T;
  await botHandoffLockClient().begin(async (lockTx) => {
    await lockTx.unsafe(`set local lock_timeout = '${HANDOFF_LOCK_WAIT_MS}ms'`);
    for (const lockKey of [...lockKeys].sort()) {
      try {
        await lockTx`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
      } catch (error) {
        if ((error as { code?: string }).code === LOCK_TIMEOUT_SQLSTATE) {
          throw new HandoffLockTimeout(`handoff lock ${lockKey} busy`);
        }
        throw error;
      }
    }
    result = await operation();
  });
  return result;
}

export async function claimBotHandoffAttempt(
  input: BotHandoffAttempt,
): Promise<boolean> {
  const predicates = and(
    eq(commands.orgId, input.orgId),
    eq(commands.kind, BOT_HANDOFF_ATTEMPT),
    eq(commands.runId, input.parentRunId),
  );
  const [existing] = await db
    .select({ id: commands.id })
    .from(commands)
    .where(and(predicates, eq(commands.payloadFingerprint, input.botId)))
    .limit(1);
  if (existing) return true;

  const [attempts] = await db
    .select({
      count: sql<number>`count(distinct ${commands.payloadFingerprint})::int`,
    })
    .from(commands)
    .where(predicates);
  if ((attempts?.count ?? 0) >= input.maxAttempts) return false;

  await db.insert(commands).values({
    id: crypto.randomUUID(),
    idempotencyKey: null,
    orgId: input.orgId,
    actorId: input.actorId,
    kind: BOT_HANDOFF_ATTEMPT,
    runId: input.parentRunId,
    threadId: input.threadId,
    payloadFingerprint: input.botId,
    payload: JSON.stringify({ botId: input.botId }),
    state: "completed",
  });
  return true;
}
