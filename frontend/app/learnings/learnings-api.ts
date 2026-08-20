import { backendFetch } from "@/lib/backend-fetch";

/**
 * Types + thin fetch layer for the learning review lane: knowledge drafts
 * (high-value run learnings awaiting review) and skill revision proposals
 * (repeated accepted learnings awaiting review). Reads throw on non-2xx so the
 * page can surface the distinct "backend unreachable" state; mutations throw a
 * human-readable message (403 means the action needs an org admin).
 */

export type KnowledgeDraftStatus = "draft" | "accepted" | "dismissed";
export type SkillProposalStatus = "proposed" | "accepted" | "dismissed";

export interface ProcedureTraceStep {
  tool: string;
  gist: string;
  ok: boolean;
}

export interface DraftEvidence {
  reason: "published_artifacts" | "long_multi_tool_run";
  engine: string;
  model: string;
  durationMs: number | null;
  stepCount: number;
  distinctStepKinds: number;
  artifactCount: number;
  artifactNames: string[];
  /** Ordered executable trace of the source run; absent on pre-feature drafts. */
  procedure?: ProcedureTraceStep[];
  /** Trailing steps the trace cap dropped ("... N more steps"). */
  procedureElided?: number;
}

export interface KnowledgeDraft {
  id: string;
  run_id: string;
  thread_id: string;
  title: string;
  content: string;
  evidence: DraftEvidence;
  status: KnowledgeDraftStatus;
  accepted_record_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface SkillProposal {
  id: string;
  skill_id: string | null;
  name: string;
  description: string;
  proposed_content: string;
  source_draft_ids: string[];
  status: SkillProposalStatus;
  resolved_skill_id: string | null;
  resolved_version: number | null;
  created_at: string;
  updated_at: string;
}

export async function fetchDrafts(): Promise<KnowledgeDraft[]> {
  const res = await backendFetch("/api/knowledge/drafts", { cache: "no-store" });
  if (!res.ok) throw new Error(`drafts ${res.status}`);
  const data = (await res.json()) as { drafts?: KnowledgeDraft[] };
  return data.drafts ?? [];
}

export async function fetchProposals(): Promise<SkillProposal[]> {
  const res = await backendFetch("/api/skills/proposals", { cache: "no-store" });
  if (!res.ok) throw new Error(`proposals ${res.status}`);
  const data = (await res.json()) as { proposals?: SkillProposal[] };
  return data.proposals ?? [];
}

async function post(path: string): Promise<void> {
  const res = await backendFetch(path, { method: "POST" });
  if (res.ok) return;
  throw new Error(
    res.status === 403 ? "Requires an org admin" : `Action failed (${res.status})`,
  );
}

export function acceptDraft(id: string): Promise<void> {
  return post(`/api/knowledge/drafts/${encodeURIComponent(id)}/accept`);
}

export function dismissDraft(id: string): Promise<void> {
  return post(`/api/knowledge/drafts/${encodeURIComponent(id)}/dismiss`);
}

export function acceptProposal(id: string): Promise<void> {
  return post(`/api/skills/proposals/${encodeURIComponent(id)}/accept`);
}

export function dismissProposal(id: string): Promise<void> {
  return post(`/api/skills/proposals/${encodeURIComponent(id)}/dismiss`);
}
