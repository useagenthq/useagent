import type { RunCommandInput, RunCommandIntent } from "./types";

/** Compatibility adapter for internal callers that do not have a distinct raw
 * ingress payload. Product ingresses pass an explicit intent instead. */
export function runIntentFromAcceptedRun(
  run: RunCommandInput["run"],
): RunCommandIntent {
  return {
    prompt: run.prompt,
    model: run.model,
    engine: run.engine,
    parentRunId: run.parentRunId,
    requestedRepos: run.repos,
    // Accepted resources contain server-derived capabilities/revisions. Internal
    // compatibility callers have no distinct raw selection, so none is invented.
    requestedResources: [],
    attachmentIds: run.attachmentIds ?? [],
    memoryScope: run.memoryScope ?? "org",
    skillId: run.skillId ?? null,
    skillVersion: run.skillVersion ?? null,
    commandName: run.commandName ?? null,
    commandProvider: run.commandProvider ?? null,
    commandSessionId: run.commandSessionId ?? null,
    commandCatalogRevision: run.commandCatalogRevision ?? null,
  };
}

/**
 * Stable content hash of the semantically-significant request fields. Two
 * submissions with a matching fingerprint are the "same" turn (an idempotent
 * replay); a mismatch under the same key is an ambiguous reuse. Ordering is
 * fixed and the run id / thread id are excluded — only the user's intent
 * (prompt, model, engine, parent, repos, skill) participates.
 */
export function runIntentFingerprint(intent: RunCommandIntent): string {
  const canonical = JSON.stringify([
    intent.prompt,
    intent.model,
    intent.engine,
    intent.parentRunId,
    // Each repo entry is "owner/name" or "owner/name:branch" (see repo-ref.ts).
    // Hashing the raw strings means a DIFFERENT branch on the same repo yields a
    // DIFFERENT fingerprint - so an Idempotency-Key replay that changes the branch
    // is (correctly) a payload mismatch, not a silent reuse of the other branch's
    // run. This falls out of the encoding for free; the test asserts it stays true.
    intent.requestedRepos,
    intent.requestedResources,
    intent.attachmentIds,
    // A skill'd turn is a distinct intent from the same prompt without one; the
    // (id, version) reference is canonical (its content hash derives from it).
    intent.skillId,
    intent.skillVersion,
    // The destination memory pool is part of the intent: replaying the same key
    // after switching org/personal must NOT silently reuse the other scope's
    // run (external audit finding — scope was stored but not fingerprinted).
    intent.memoryScope,
    // A VALIDATED native-command turn is a distinct intent from the same text as a
    // normal prompt (it skips context + is delivered verbatim), so it participates.
    intent.commandName,
    // The FULL accepted command IDENTITY (D5): provider + native session + catalog revision. Two
    // commands with the same NAME but a different provider/session/revision are DIFFERENT intents
    // (a different authorization), so an Idempotency-Key replay that changes any of them must NOT
    // silently reuse the other run - the identity participates in the fingerprint, not only the name.
    intent.commandProvider,
    intent.commandSessionId,
    intent.commandCatalogRevision,
  ]);
  return new Bun.CryptoHasher("sha256").update(canonical).digest("hex");
}
