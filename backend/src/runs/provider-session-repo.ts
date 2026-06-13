import {
  parseProviderSessionBinding,
  type ProviderSessionBinding,
} from "@useagent/agent-harness/canonical";
import { and, desc, eq, isNotNull, ne } from "drizzle-orm";
import { db, type Executor } from "../db/client";
import { runs } from "../db/schema";

type RunRecord = typeof runs.$inferSelect;

/** Durable provider-session authority for a run. The legacy native id remains
 * mirrored for old readers, while the typed binding is the resumable truth. */
export async function setRunProviderSession(
  id: string,
  binding: ProviderSessionBinding,
  exec: Executor = db,
): Promise<void> {
  const parsed = parseProviderSessionBinding(binding);
  if (!parsed) throw new Error("setRunProviderSession: invalid provider session binding");
  const updated = await exec
    .update(runs)
    .set({
      engineSessionId: parsed.nativeSessionId,
      providerSession: parsed,
    })
    .where(eq(runs.id, id))
    .returning({ id: runs.id });
  if (updated.length === 0) {
    throw new Error(`setRunProviderSession: run ${id} not found (no row updated)`);
  }
}

/** Legacy native-session persistence. Writing through this compatibility path
 * deliberately clears typed authority so a partial binding cannot be resumed. */
export async function setRunEngineSession(
  id: string,
  sessionId: string,
  exec: Executor = db,
): Promise<void> {
  const updated = await exec
    .update(runs)
    .set({ engineSessionId: sessionId, providerSession: null })
    .where(eq(runs.id, id))
    .returning({ id: runs.id });
  if (updated.length === 0) {
    throw new Error(`setRunEngineSession: run ${id} not found (no row updated)`);
  }
}

export interface ThreadProviderSessionState {
  readonly binding: ProviderSessionBinding | null;
  readonly legacySessionId: string | null;
}

/** Most recent same-engine provider session in a thread, excluding the turn
 * being admitted. A thread may mix engines; native sessions never transfer. */
export async function getThreadProviderSessionState(
  threadId: string,
  engine: string,
  excludeRunId: string,
): Promise<ThreadProviderSessionState> {
  const [row] = await db
    .select({
      binding: runs.providerSession,
      legacySessionId: runs.engineSessionId,
    })
    .from(runs)
    .where(
      and(
        eq(runs.threadId, threadId),
        eq(runs.engine, engine as RunRecord["engine"]),
        ne(runs.id, excludeRunId),
        isNotNull(runs.engineSessionId),
      ),
    )
    .orderBy(desc(runs.createdAt), desc(runs.id))
    .limit(1);
  return {
    binding: parseProviderSessionBinding(row?.binding),
    legacySessionId: row?.legacySessionId ?? null,
  };
}

/** Compatibility helper for callers not yet migrated to typed authority. */
export async function getThreadEngineSession(
  threadId: string,
  engine: string,
  excludeRunId: string,
): Promise<string | null> {
  const state = await getThreadProviderSessionState(threadId, engine, excludeRunId);
  return state.binding?.nativeSessionId ?? state.legacySessionId;
}
