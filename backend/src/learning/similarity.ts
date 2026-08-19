import type { SkillSections } from "../db/schema";

// ---------------------------------------------------------------------------
// Deterministic draft similarity + skill-proposal assembly (item 6). When an
// accepted knowledge draft looks like a REPEATED procedure (>= 2 similar prior
// accepted drafts by title-keyword overlap), the group is assembled into a
// skill revision proposal. Everything here is pure: same inputs, same output —
// no embeddings, no LLM — so the "repeated procedure" judgment is auditable.
// ---------------------------------------------------------------------------

/** Common English/product glue words that carry no procedure identity. */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "into", "onto", "that", "this", "then",
  "than", "when", "what", "where", "which", "over", "under", "about", "after",
  "before", "each", "every", "have", "has", "had", "will", "would", "should",
  "could", "can", "may", "might", "must", "not", "all", "any", "are", "was",
  "were", "been", "being", "its", "our", "their", "your", "you", "please",
  "using", "use", "used", "make", "made", "run", "runs", "task", "tasks",
  "new", "get", "set", "how", "why", "who", "does", "did", "done", "them",
]);

/** Lowercased keyword set of a title: alphanumeric words, length >= 3, minus
 *  stopwords. The unit the similarity below compares. */
export function titleKeywords(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w)),
  );
}

/** Two drafts describe the same procedure when their titles share at least
 *  half of their combined keywords (Jaccard >= 0.5). */
export const SIMILARITY_THRESHOLD = 0.5;

/** Jaccard similarity of the two titles' keyword sets, in [0, 1]. A title with
 *  no keywords matches nothing (never everything). */
export function titleSimilarity(a: string, b: string): number {
  const ka = titleKeywords(a);
  const kb = titleKeywords(b);
  if (ka.size === 0 || kb.size === 0) return 0;
  return ka.intersection(kb).size / ka.union(kb).size;
}

/** How many similar prior drafts an accepted draft needs before a skill
 *  revision proposal is raised (>= 2 priors, i.e. a third occurrence). */
export const MIN_SIMILAR_PRIOR_DRAFTS = 2;

/** The most frequent keywords across the group's titles — the topic label used
 *  in the assembled proposal. Deterministic tie-break: alphabetical. */
export function topKeywords(titles: string[], limit = 4): string[] {
  const counts = new Map<string, number>();
  for (const title of titles) {
    for (const word of titleKeywords(title)) {
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([word]) => word);
}

/** One accepted draft feeding a proposal (oldest → newest order expected). */
export interface ProposalSourceDraft {
  id: string;
  runId: string;
  title: string;
}

export interface AssembledSkillProposal {
  name: string;
  description: string;
  sections: SkillSections;
}

const NAME_CAP = 80;

/**
 * Assemble a skill proposal from a group of similar accepted drafts. The name
 * comes from the NEWEST draft's title (the most recent phrasing of the
 * procedure); the sections record provenance (which learnings, which runs) and
 * point the agent at the accepted knowledge, honestly labeled as assembled
 * rather than pretending to be a hand-authored procedure. Pure.
 */
export function assembleSkillProposal(drafts: ProposalSourceDraft[]): AssembledSkillProposal {
  const newest = drafts[drafts.length - 1];
  if (!newest) throw new Error("assembleSkillProposal requires at least one draft");
  const topic = topKeywords(drafts.map((d) => d.title));
  return {
    name: newest.title.slice(0, NAME_CAP).trim(),
    description:
      `Recurring procedure observed across ${drafts.length} accepted learnings` +
      (topic.length ? ` about ${topic.join(", ")}.` : "."),
    sections: {
      overview: [
        `Assembled from ${drafts.length} accepted learning drafts with matching topics.`,
        ...drafts.map((d) => `${d.title} (run ${d.runId.slice(0, 8)})`),
      ],
      procedure: [
        topic.length
          ? `Search org knowledge for "${topic.join(" ")}" and read the accepted learnings this playbook was assembled from.`
          : "Search org knowledge for the accepted learnings this playbook was assembled from.",
        "Apply the same approach those learnings record, adapting names, paths, and parameters to the current task.",
      ],
      verify: [
        "Confirm the outcome matches what the accepted learnings describe as a successful result.",
      ],
    },
  };
}
