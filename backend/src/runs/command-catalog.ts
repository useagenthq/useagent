import type { SessionCommandCatalog } from "@useagent/agent-client/wire";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/client";
import type { AppEnv } from "../http";
import { orgScope } from "../middleware/org";

// ---------------------------------------------------------------------------
// Slash-command catalogs. A native session advertises its command list as a
// durable canonical `commands.updated` event. Two readers use it:
//   - the authoritative per-session catalog a typed command intent is
//     authorized against (exactly what THIS session advertised);
//   - the pre-session picker (GET /api/commands), which shows the latest
//     catalog any session of the current org advertised for the chosen engine,
//     so "/" autocomplete works on the New Task composer before a sandbox
//     exists. It is UI-only and never authorizes execution.
// ---------------------------------------------------------------------------

export interface CatalogCommand {
  readonly name: string;
  readonly description: string | null;
  readonly input: string | null;
}

interface CommandsUpdatedBody {
  readonly catalog?: unknown;
  readonly commands?: unknown;
}

/** The commands in a `commands.updated` body: the structured `catalog` when present,
 *  else the bare `commands` name list; anything without a usable name is dropped. */
function commandsFromBody(body: CommandsUpdatedBody): CatalogCommand[] {
  const list = Array.isArray(body.catalog)
    ? body.catalog
    : Array.isArray(body.commands)
      ? (body.commands as unknown[]).map((n) => ({ name: n }))
      : [];
  return list
    .map((c) => {
      const rec = c as { name?: unknown; description?: unknown; input?: unknown };
      return {
        name: typeof rec.name === "string" ? rec.name : "",
        description: typeof rec.description === "string" ? rec.description : null,
        input: typeof rec.input === "string" ? rec.input : null,
      };
    })
    .filter((c) => c.name.length > 0);
}

/** The AUTHORITATIVE command catalog for a SPECIFIC native session, read from the DURABLE
 *  canonical stream: the LATEST `commands.updated` for that session in the thread, WITH its
 *  `revision` (that event's `delivery_seq` - a monotonic snapshot id that also advances when a
 *  relay regeneration re-advertises). This is the ONLY thing a native-command intent is
 *  authorized against - exactly what THIS session advertised, never an org-wide picker cache.
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
    order by delivery_seq desc limit 1`)) as unknown as Array<{ body: CommandsUpdatedBody; delivery_seq: number | string }>;
  const row = rows[0];
  if (!row?.body) return null;
  return { commands: commandsFromBody(row.body), revision: Number(row.delivery_seq) };
}

/** The latest catalog any native session of `orgId` advertised for `provider`, for the
 *  pre-session picker. Org-scoped through the run that owns the thread, so one tenant's
 *  session-derived commands (which can include org-specific skills) never reach another;
 *  engine-scoped so a Claude picker never shows Codex commands. Null until some session
 *  of that engine has advertised a catalog. */
export async function readLatestEngineCommandCatalog(
  orgId: string,
  provider: string,
): Promise<{ commands: CatalogCommand[]; fetchedAt: Date } | null> {
  const rows = (await db.execute(sql`
    select ce.body, ce.created_at from canonical_events ce
    where ce.kind = 'commands.updated'
      and ce.identity->>'provider' = ${provider}
      and exists (
        select 1 from runs r where r.id = ce.run_id and r.org_id = ${orgId}
      )
    order by ce.created_at desc, ce.delivery_seq desc limit 1`)) as unknown as Array<{ body: CommandsUpdatedBody; created_at: string | Date }>;
  const row = rows[0];
  if (!row?.body) return null;
  return { commands: commandsFromBody(row.body), fetchedAt: new Date(row.created_at) };
}

// ── Route ────────────────────────────────────────────────────────────────────
// GET /api/commands?engine=<id> → the current org's latest catalog for that engine.
export const commandsRoutes = new Hono<AppEnv>();
commandsRoutes.use("*", orgScope);

commandsRoutes.get("/", async (c) => {
  const engine = c.req.query("engine")?.trim() || "opencode";
  const orgId = c.get("orgId");
  const latest = orgId ? await readLatestEngineCommandCatalog(orgId, engine) : null;
  return c.json({
    engine,
    commands: latest?.commands ?? [],
    fetched_at: latest ? latest.fetchedAt.toISOString() : null,
  });
});
