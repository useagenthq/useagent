import type { RunCommandInput } from "./types";

/**
 * Stable content hash of the semantically-significant request fields. Two
 * submissions with a matching fingerprint are the "same" turn (an idempotent
 * replay); a mismatch under the same key is an ambiguous reuse. Ordering is
 * fixed and the run id / thread id are excluded — only the user's intent
 * (prompt, model, engine, parent, repos) participates.
 */
export function runPayloadFingerprint(run: RunCommandInput["run"]): string {
  const canonical = JSON.stringify([
    run.prompt,
    run.model,
    run.engine,
    run.parentRunId,
    run.repos,
  ]);
  return new Bun.CryptoHasher("sha256").update(canonical).digest("hex");
}
