// Legacy engine-id aliases -> their canonical provider. `daytona` is the old
// OpenCode alias and `claude-sdk` the old Claude alias: pre-consolidation run rows
// (and their replies) plus direct API callers can still submit them, and they run
// the SAME adapter as their base (see engines/index.ts). They must therefore
// FINALIZE and TRANSLATE into the canonical lane IDENTICALLY to their base - never
// be a selectable engine silently left outside the canonical lane (Slice 3 step 7).
// Unknown / already-canonical ids pass through unchanged.
const ENGINE_ALIASES: Record<string, string> = {
  daytona: "opencode",
  "claude-sdk": "claude",
};

/** Normalize a stored engine id to the canonical provider used by the canonical
 *  event lane (finalize gate + translator provenance). Pure + total. */
export function canonicalEngine(engine: string): string {
  return ENGINE_ALIASES[engine] ?? engine;
}
