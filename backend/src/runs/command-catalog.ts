import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/client";
import { commandsCatalog, type CatalogCommand } from "../db/schema";
import type { AppEnv } from "../http";
import { orgScope } from "../middleware/org";

// ---------------------------------------------------------------------------
// Slash-command catalog — a snapshot-level cache of the engine's real command
// list (opencode's GET /command). The list is identical for every fresh sandbox
// of a given snapshot, so it is fetched opportunistically (the live-proxy taps
// any thread's /command response) and cached ONCE per snapshot. The New Task
// composer reads it via GET /api/commands to power "/" autocomplete BEFORE a
// sandbox exists. Best-effort throughout: a caching failure must never disturb
// the live-proxy, and an empty cache simply means no popover.
// ---------------------------------------------------------------------------

/** The snapshot new sandboxes are created from. Mirrors the resolution in
 *  engines/opencode-server.ts — the catalog is keyed by exactly this value. */
export function defaultSnapshot(): string {
  return process.env.DAYTONA_SNAPSHOT ?? "skynet-agent-v17";
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

/** Read a snapshot's cached catalog, or null when it has never been cached. */
export async function readCommandCatalog(
  snapshot: string,
): Promise<{ commands: CatalogCommand[]; fetchedAt: Date } | null> {
  const [row] = await db
    .select()
    .from(commandsCatalog)
    .where(eq(commandsCatalog.snapshot, snapshot))
    .limit(1);
  return row ? { commands: row.commands, fetchedAt: row.fetchedAt } : null;
}

// ── Route ────────────────────────────────────────────────────────────────────
// GET /api/commands → the cached catalog for the current default snapshot.
// Org-scoped like every domain route (auth gate); the catalog itself is
// snapshot-global — the command list carries no tenant data.
export const commandsRoutes = new Hono<AppEnv>();
commandsRoutes.use("*", orgScope);

commandsRoutes.get("/", async (c) => {
  const cached = await readCommandCatalog(defaultSnapshot());
  return c.json({
    commands: cached?.commands ?? [],
    fetched_at: cached ? cached.fetchedAt.toISOString() : null,
  });
});
