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

/** Validate a native-command intent against the active authoritative catalog. The command
 *  NAME must appear in the catalog; when the client supplies a session id or catalog revision
 *  it must match the currently-active one (a stale cache or a wrong session is rejected, never
 *  silently executed). Product skills are versioned skill IDs handled elsewhere - a skill id is
 *  NEVER a native command, so it can never validate here. Pure. */
export function validateCommandIntent(
  intent: CommandIntent,
  catalog: readonly { readonly name: string }[],
  active?: { readonly sessionId?: string | null; readonly revision?: number | null },
): CommandValidation {
  const name = typeof intent.name === "string" ? intent.name.trim() : "";
  if (!name) return { ok: false, reason: "empty command name" };
  if (name.includes("/") || /\s/.test(name)) return { ok: false, reason: "malformed command name" };
  if (!catalog.some((c) => c.name === name)) return { ok: false, reason: "unknown command" };
  if (intent.sessionId && active?.sessionId && intent.sessionId !== active.sessionId) {
    return { ok: false, reason: "stale session" };
  }
  if (intent.catalogRevision != null && active?.revision != null && intent.catalogRevision !== active.revision) {
    return { ok: false, reason: "stale catalog revision" };
  }
  return { ok: true, name, args: typeof intent.args === "string" ? intent.args : "" };
}
