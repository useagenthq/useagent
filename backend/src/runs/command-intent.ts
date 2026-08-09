// ---------------------------------------------------------------------------
// Typed native-command submission contract (Phase 3). A native provider command
// is NOT arbitrary slash-prefixed text: it is an explicit, typed intent that the
// trusted backend VALIDATES against the active authoritative command catalog
// before it is allowed to skip the operating-rules / memory / skill / context
// prefix. This keeps two things honest:
//   - a normal prompt that merely starts with "/" still gets the full context;
//   - only a command whose name is actually advertised (and, when supplied, for
//     the current session/catalog revision) is delivered byte-verbatim.
// Pure + dependency-free so the run route + tests can validate without a DB.
// ---------------------------------------------------------------------------

/** A client's native-command intent, carried additively on the run API alongside the raw
 *  prompt. `args` is the ORIGINAL argument bytes (never trimmed) so the provider prompt is
 *  reconstructed exactly. The identity fields let the backend reject a stale/cross-session
 *  intent. */
export interface CommandIntent {
  readonly name: string;
  readonly args?: string;
  /** Engine/provider the client believes advertised the command (claude|codex|opencode). */
  readonly provider?: string;
  /** The native session the client saw the catalog for. */
  readonly sessionId?: string;
  /** The catalog revision the client selected against. */
  readonly catalogRevision?: number;
}

export type CommandValidation =
  | { readonly ok: true; readonly name: string; readonly args: string }
  | { readonly ok: false; readonly reason: string };

/** Build the provider prompt for a native command EXACTLY ONCE in the trusted backend:
 *  `/name` plus the original argument bytes (a single separating space when args are present).
 *  Never trims the args, so whitespace/unicode/multiline arguments survive byte-for-byte. */
export function buildNativeCommandPrompt(name: string, args?: string | null): string {
  const a = typeof args === "string" ? args : "";
  return a.length > 0 ? `/${name} ${a}` : `/${name}`;
}

/** FAIL-CLOSED validation of a native-command intent against the LIVE session's authoritative
 *  catalog. A native command is authorized ONLY when it can be tied to a real, current session
 *  and the exact catalog snapshot the client selected against:
 *    - there MUST be an active session (`active.sessionId`); with none, no command authorizes
 *      (a pre-session priming cache is UI-only and never authorizes execution);
 *    - the NAME must appear in that session's catalog;
 *    - the client MUST supply a session id, and it MUST equal the server-derived active session
 *      (a stale/cross-session intent is rejected, never silently executed);
 *    - when the session catalog carries a revision (its latest `commands.updated` deliverySeq -
 *      which also advances on a relay regeneration re-advertisement), the client MUST supply a
 *      matching `catalogRevision` (a stale snapshot is rejected).
 *  Product skills are versioned skill IDs handled elsewhere - a skill id is NEVER a native
 *  command, so it can never validate here. Pure. */
export function validateCommandIntent(
  intent: CommandIntent,
  catalog: readonly { readonly name: string }[],
  active: { readonly sessionId: string | null; readonly revision: number | null },
): CommandValidation {
  const name = typeof intent.name === "string" ? intent.name.trim() : "";
  if (!name) return { ok: false, reason: "empty command name" };
  if (name.includes("/") || /\s/.test(name)) return { ok: false, reason: "malformed command name" };
  // fail-closed: authorize ONLY against a live session's catalog (never a pre-session cache).
  if (!active.sessionId) return { ok: false, reason: "no active session" };
  if (!catalog.some((c) => c.name === name)) return { ok: false, reason: "unknown command" };
  // the client must PROVE which session + catalog snapshot it selected against.
  if (!intent.sessionId) return { ok: false, reason: "missing session id" };
  if (intent.sessionId !== active.sessionId) return { ok: false, reason: "stale session" };
  if (active.revision != null) {
    if (intent.catalogRevision == null) return { ok: false, reason: "missing catalog revision" };
    if (intent.catalogRevision !== active.revision) return { ok: false, reason: "stale catalog revision" };
  }
  return { ok: true, name, args: typeof intent.args === "string" ? intent.args : "" };
}

/** FAIL-CLOSED re-validation IMMEDIATELY before dispatch (D4). Accept-time validation can go stale
 *  before the adapter sends the turn (relay regeneration, session replacement, or a provider
 *  catalog update). The persisted acceptance identity must be complete, must still identify the
 *  resident provider session, and the command must still be present in the provider's CURRENT
 *  in-memory/freshly-fetched catalog. `catalogRevision` proves which durable snapshot authorized
 *  acceptance; the live provider snapshot has no canonical delivery sequence of its own, so
 *  revalidation checks current membership rather than inventing a cross-domain revision comparison.
 *  Returns null when dispatch is safe, otherwise a visible rejection reason. Pure. */
export function revalidateCommandBeforeDispatch(
  cmd: { readonly name: string; readonly provider: string | null; readonly sessionId: string | null; readonly catalogRevision: number | null },
  live: { readonly engine: string; readonly sessionId: string; readonly catalog: readonly { readonly name: string }[] | null },
): string | null {
  const reasons: string[] = [];
  if (!cmd.provider) reasons.push("missing provider");
  else if (cmd.provider !== live.engine) reasons.push(`provider ${cmd.provider} != ${live.engine}`);
  if (!cmd.sessionId) reasons.push("missing session id");
  else if (cmd.sessionId !== live.sessionId) reasons.push(`session ${cmd.sessionId.slice(0, 8)} != ${live.sessionId.slice(0, 8)}`);
  if (cmd.catalogRevision == null) reasons.push("missing catalog revision");
  if (!(live.catalog ?? []).some((c) => c.name === cmd.name)) reasons.push(`"/${cmd.name}" not in the live session catalog`);
  return reasons.length > 0 ? reasons.join("; ") : null;
}
