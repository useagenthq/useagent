import { decodeThreadRelationshipEnvelope } from "@useagent/agent-client";

export type InitialThreadRelationshipHint =
  | "root"
  | "child"
  | "legacy_or_off"
  | "ambiguous"
  | "inapplicable";

export async function loadThreadRelationshipHint(
  threadId: string,
  fetcher: (input: string, init?: RequestInit) => Promise<Response>,
  applicable = true,
): Promise<InitialThreadRelationshipHint> {
  if (!applicable) return "inapplicable";
  try {
    const response = await fetcher(
      `/api/threads/${encodeURIComponent(threadId)}/relationship`,
      { cache: "no-store" },
    );
    if (response.status === 404) return "legacy_or_off";
    if (!response.ok) return "ambiguous";
    const relationship = decodeThreadRelationshipEnvelope(await response.json());
    if (!relationship) return "ambiguous";
    return relationship.parentThreadId ? "child" : "root";
  } catch {
    return "ambiguous";
  }
}
