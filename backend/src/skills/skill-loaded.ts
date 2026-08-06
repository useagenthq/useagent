// skill.loaded marker (mem_op 0.1 / 0.5). When a run loads a pinned skill, record
// a `skill.loaded` frame on the existing native-event lane (provider_events + SSE)
// so it is durable, replayable, and rendered as a typed row in the shared timeline
// alongside context.retrieved. Metadata only — id/version/name/hash — NEVER the
// skill body (bounded-payload rule: markers carry references, not oversized
// content). Mirrors memory/retrieval-ledger.ts.

import type { SkillKind } from "../db/schema";
import { recordProviderEvent } from "../runs/provider-events";

/** The native `eventType` for a skill-load marker. */
export const SKILL_LOADED = "skill.loaded";

/** Bounded skill.loaded payload — the pinned revision's identity, no content. */
export interface SkillLoadedPayload {
  readonly skillId: string;
  readonly version: number;
  /** "skill" | "playbook" - lets the timeline label the row "Playbook <name>". */
  readonly kind: SkillKind;
  readonly name: string;
  readonly contentHash: string;
  /** Discriminator shared with context.retrieved's `source` in the timeline. */
  readonly source: "skill";
  /** Rendered SKILL.md length (chars). The content itself is deliberately omitted. */
  readonly contentChars: number;
}

/**
 * Record a run's skill load as a `skill.loaded` native frame (persist + stream).
 * One frame per run (id keyed by runId). The worker AWAITS this (before the
 * engine runs) so the marker is durable before the run can settle, and .catches
 * a persist failure so it never fails the run.
 */
export async function recordSkillLoaded(
  runId: string,
  threadId: string,
  loaded: SkillLoadedPayload,
): Promise<void> {
  // Emitted at run START (before any provider part), so the shared per-run
  // sequencer mints an early seq and every opencode capture a strictly higher one.
  await recordProviderEvent({
    id: `skillloaded_${runId}`,
    runId,
    threadId,
    provider: "skynet",
    eventType: SKILL_LOADED,
    payload: loaded,
  });
}
