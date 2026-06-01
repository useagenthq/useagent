import type { ArtifactWorkpieceKind } from "@useagent/agent-client";

/** A typed reference to the exact canonical workpiece a follow-up is about, so the
 * agent knows which document to edit (it proposes against this artifact id). */
export interface WorkpieceRef {
  readonly artifactId: string;
  readonly name: string;
  readonly kind: ArtifactWorkpieceKind;
  readonly revision: number;
}

/** Compose the session reply seeded by the per-workpiece "Ask a follow-up" input:
 * a typed workpieceRef context prefix (artifact id + name + kind + current
 * revision) followed by the user's request, so the agent edits exactly the right
 * canonical document (its edits then flow propose/auto-accept as normal). Pure so
 * the wording stays testable. */
export function workpieceFollowUpMessage(ref: WorkpieceRef, text: string): string {
  const body = text.trim();
  return `Regarding workpiece ${ref.artifactId} ("${ref.name}", ${ref.kind}, revision ${ref.revision}):\n${body}`;
}
