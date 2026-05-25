// ---------------------------------------------------------------------------
// Run origin — the first-class notion of an INTERNAL run (memory
// self-improvement item 2). Runs created by our own canaries and test harnesses
// (release-lane parity canaries, e2e/soak suites, QC probes) must never enter
// org memory, so acceptance derives an `origin` marker from the EXPLICIT
// identifiers those tools already stamp — the idempotency key and/or the run id
// prefix — never from prompt sniffing. The matched marker is persisted on
// `runs.origin` (null = a real product run) and finalization skips the memory
// capture for any internal origin.
// ---------------------------------------------------------------------------

/** Clear internal-marker prefixes our own tooling stamps on idempotency keys and
 *  run ids (observed: `t3-parity:<case>`, `t3-parity-<id>` run ids,
 *  `release-eval:<case>`, `hosted-release-canary:<label>`, `e2e-<uuid>`,
 *  `PARITY_...`). Generic marker prefixes only — no per-case lists. Product
 *  channels use disjoint prefixes (`slack-ack:`, `child-session:`, sched keys)
 *  and client UUIDs, so a real run never matches. */
const INTERNAL_RUN_MARKERS = [
  "t3-parity",
  "release-eval",
  "hosted-release-canary",
  "canary",
  "parity",
  "e2e",
] as const;

/** A marker only matches at a token boundary ("e2e-…", "canary:…", exact), so a
 *  product value that merely CONTAINS a marker string never matches. */
const MARKER_SEPARATORS = new Set([":", "-", "_", "."]);

function matchInternalMarker(value: string | null | undefined): string | null {
  if (!value) return null;
  const lower = value.toLowerCase();
  for (const marker of INTERNAL_RUN_MARKERS) {
    if (!lower.startsWith(marker)) continue;
    const next = lower.charAt(marker.length);
    if (next === "" || MARKER_SEPARATORS.has(next)) return marker;
  }
  return null;
}

/**
 * Derive a run's origin at command acceptance: the matched internal marker when
 * the idempotency key or the pre-allocated run id carries one, else null (a real
 * product run). Pure — unit-tested directly.
 */
export function deriveRunOrigin(idempotencyKey: string | null, runId: string): string | null {
  return matchInternalMarker(idempotencyKey) ?? matchInternalMarker(runId);
}

/** True when a persisted `runs.origin` marks the run internal. Matched by the
 *  same marker prefixes (so a compound value like "parity-canary" still reads as
 *  internal), and a null origin — every product run — is never internal. */
export function isInternalRunOrigin(origin: string | null): boolean {
  return matchInternalMarker(origin) !== null;
}
