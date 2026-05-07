import type { RunCommandInput } from "./types";

/**
 * Stable content hash of the semantically-significant request fields. Two
 * submissions with a matching fingerprint are the "same" turn (an idempotent
 * replay); a mismatch under the same key is an ambiguous reuse. Ordering is
 * fixed and the run id / thread id are excluded — only the user's intent
 * (prompt, model, engine, parent, repos, skill) participates.
 */
export function runPayloadFingerprint(run: RunCommandInput["run"]): string {
  const canonical = JSON.stringify([
    run.prompt,
    run.model,
    run.engine,
    run.parentRunId,
    // Each repo entry is "owner/name" or "owner/name:branch" (see repo-ref.ts).
    // Hashing the raw strings means a DIFFERENT branch on the same repo yields a
    // DIFFERENT fingerprint - so an Idempotency-Key replay that changes the branch
    // is (correctly) a payload mismatch, not a silent reuse of the other branch's
    // run. This falls out of the encoding for free; the test asserts it stays true.
    run.repos,
    // A skill'd turn is a distinct intent from the same prompt without one; the
    // (id, version) reference is canonical (its content hash derives from it).
    run.skillId ?? null,
    run.skillVersion ?? null,
    // The destination memory pool is part of the intent: replaying the same key
    // after switching org/personal must NOT silently reuse the other scope's
    // run (external audit finding — scope was stored but not fingerprinted).
    run.memoryScope ?? null,
  ]);
  return new Bun.CryptoHasher("sha256").update(canonical).digest("hex");
}
