import type { CanonicalCommand } from "@useagent/agent-harness/canonical";
import type { SessionCommandCatalog } from "@useagent/agent-client/wire";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/client";
import { commandsCatalog, type CatalogCommand } from "../db/schema";
import type { AppEnv } from "../http";
import { orgScope } from "../middleware/org";
import { sandboxTemplate } from "../sandboxes/provider";

// ---------------------------------------------------------------------------
// Slash-command catalog — a snapshot-level cache of the engine's real command
// list (opencode's GET /command). The list is identical for every fresh sandbox
// of a given snapshot, so it is fetched opportunistically from a live sandbox
// and cached ONCE per snapshot. The New Task
// composer reads it via GET /api/commands to power "/" autocomplete BEFORE a
// sandbox exists. Best-effort throughout: a caching failure must never disturb
// a turn, and an empty cache simply means no popover.
// ---------------------------------------------------------------------------

/** The snapshot new sandboxes are created from. Mirrors the resolution in
 *  engines/opencode-server.ts — the catalog is keyed by exactly this value. */
export function defaultSnapshot(): string {
  return sandboxTemplate("DAYTONA_SNAPSHOT");
}

/** Normalize opencode's /command body (a bare `{name, description}[]`) into the
 *  cached shape, dropping anything without a usable name. */
function normalize(raw: unknown): CatalogCommand[] {
  if (!Array.isArray(raw)) return [];
  const out: CatalogCommand[] = [];
  for (const item of raw) {
    const rec = item as { name?: unknown; description?: unknown };
    if (typeof rec.name !== "string" || rec.name.length === 0) continue;
    out.push({
      name: rec.name,
      description: typeof rec.description === "string" ? rec.description : null,
    });
  }
  return out;
}

/**
 * Cache a snapshot's command catalog from a raw /command response body. Upserts
 * only when the parse yields a NON-empty list, so a transient empty/garbled
 * response never clobbers a good cache. Never throws — callers fire-and-forget.
 */
export async function cacheCommandCatalog(snapshot: string, rawBody: string): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return;
  }
  const commands = normalize(parsed);
  if (commands.length === 0) return;

  await db
    .insert(commandsCatalog)
    .values({ snapshot, commands, fetchedAt: new Date() })
    .onConflictDoUpdate({
      target: commandsCatalog.snapshot,
      set: { commands, fetchedAt: new Date() },
    });
}

/** The AUTHORITATIVE command catalog for a SPECIFIC native session, read from the DURABLE
 *  canonical stream: the LATEST `commands.updated` for that session in the thread, WITH its
 *  `revision` (that event's `delivery_seq` - a monotonic snapshot id that also advances when a
 *  relay regeneration re-advertises). This is the ONLY thing a native-command intent is
 *  authorized against - exactly what THIS session advertised, never an org-wide priming cache.
 *  `commands` is [] when the session advertised none; the whole result is null when the session
 *  has not advertised a catalog yet (the caller then FAILS CLOSED - a command cannot be
 *  authorized against a cache). */
export async function readSessionCommandCatalog(
  threadId: string,
  provider: string,
  sessionId: string,
): Promise<SessionCommandCatalog | null> {
  const rows = (await db.execute(sql`
    select body, delivery_seq from canonical_events
    where thread_id = ${threadId} and kind = 'commands.updated'
      and identity->>'provider' = ${provider}
      and identity->>'nativeSessionId' = ${sessionId}
    order by delivery_seq desc limit 1`)) as unknown as Array<{ body: { catalog?: unknown; commands?: unknown }; delivery_seq: number | string }>;
  const row = rows[0];
  if (!row?.body) return null;
  const body = row.body;
  const list = Array.isArray(body.catalog)
    ? body.catalog
    : Array.isArray(body.commands)
      ? (body.commands as unknown[]).map((n) => ({ name: n }))
      : [];
  const commands = list
    .map((c) => {
      const rec = c as { name?: unknown; description?: unknown; input?: unknown };
      return {
        name: typeof rec.name === "string" ? rec.name : "",
        description: typeof rec.description === "string" ? rec.description : null,
        input: typeof rec.input === "string" ? rec.input : null,
      };
    })
    .filter((c) => c.name.length > 0);
  return { commands, revision: Number(row.delivery_seq) };
}

/** Read a keyed catalog (snapshot name, or an `acp:<engine>` key), or null. */
export async function readCommandCatalog(
  key: string,
): Promise<{ commands: CatalogCommand[]; fetchedAt: Date } | null> {
  const [row] = await db
    .select()
    .from(commandsCatalog)
    .where(eq(commandsCatalog.snapshot, key))
    .limit(1);
  return row ? { commands: row.commands, fetchedAt: row.fetchedAt } : null;
}

async function upsertCatalog(key: string, commands: readonly CanonicalCommand[]): Promise<void> {
  const rows: CatalogCommand[] = commands.map((c) => ({
    name: c.name,
    description: c.description ?? null,
    input: c.input ?? null,
  }));
  await db
    .insert(commandsCatalog)
    .values({ snapshot: key, commands: rows, fetchedAt: new Date() })
    .onConflictDoUpdate({ target: commandsCatalog.snapshot, set: { commands: rows, fetchedAt: new Date() } })
    .catch(() => {});
}

// ── Route ────────────────────────────────────────────────────────────────────
// GET /api/commands → the cached catalog for the current default snapshot.
// Org-scoped like every domain route (auth gate); the catalog itself is
// snapshot-global — the command list carries no tenant data.
export const commandsRoutes = new Hono<AppEnv>();
commandsRoutes.use("*", orgScope);

commandsRoutes.get("/", async (c) => {
  // The pre-session picker reads the org-neutral snapshot catalog; a live session's
  // own command snapshot arrives on the thread stream and always wins.
  const engine = c.req.query("engine");
  const cached = await readCommandCatalog(defaultSnapshot());
  return c.json({
    engine: engine ?? "opencode",
    commands: cached?.commands ?? [],
    fetched_at: cached ? cached.fetchedAt.toISOString() : null,
  });
});
