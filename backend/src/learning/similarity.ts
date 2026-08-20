import type { ProcedureTraceStep, SkillSections } from "../db/schema";

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

// --- Procedure backbone -----------------------------------------------------
// When the source drafts carry executable traces (evidence.procedure), the
// proposal's Procedure section is assembled from their COMMON ordered backbone
// instead of the generic "search knowledge" text. Same rule as everything else
// here: deterministic and auditable, no model in the loop.

/** Run-specific tokens that must not survive into a reusable playbook step:
 *  UUIDs, prefixed ids (ses_, run_, sb_ tails), long hex ids, and long digit
 *  runs. Short numbers (PR #123, ports) are stable arguments and stay. */
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const PREFIXED_ID_RE = /\b[a-z]+_[A-Za-z0-9]{6,}\b/g;
const HEX_ID_RE = /\b[0-9a-f]{8,}\b/gi;
const LONG_NUMBER_RE = /\b\d{5,}\b/g;

/** Generalize a trace gist for reuse: strip run-specific ids/tokens, keep the
 *  stable arguments (paths, repo names, short numbers, flag names). Pure. */
export function generalizeGist(gist: string): string {
  return gist
    .replace(UUID_RE, "<id>")
    .replace(PREFIXED_ID_RE, "<id>")
    .replace(HEX_ID_RE, "<id>")
    .replace(LONG_NUMBER_RE, "<n>")
    .replace(/\s+/g, " ")
    .trim();
}

/** Backbone cap — a hard bound on the assembled Procedure section. */
export const MAX_BACKBONE_STEPS = 24;

/**
 * The common ordered backbone of a group of procedure traces: keep the tools
 * that appear in the MAJORITY of the traces, in first-seen order (traces
 * scanned oldest → newest, steps in order). Each kept tool carries ONE
 * generalized gist — from the newest trace that used it (the most recent
 * phrasing of the step, matching how the proposal takes its name). Pure.
 */
export function procedureBackbone(
  traces: readonly (readonly ProcedureTraceStep[])[],
): { tool: string; gist: string }[] {
  const present = traces.filter((t) => t.length > 0);
  if (present.length === 0) return [];
  const majority = Math.floor(present.length / 2) + 1;

  const firstSeen: string[] = [];
  const traceCount = new Map<string, number>();
  const newestGist = new Map<string, string>();
  for (const trace of present) {
    const seenHere = new Set<string>();
    for (const step of trace) {
      if (!traceCount.has(step.tool)) firstSeen.push(step.tool);
      if (seenHere.has(step.tool)) continue;
      seenHere.add(step.tool);
      traceCount.set(step.tool, (traceCount.get(step.tool) ?? 0) + 1);
      // Later traces overwrite: the map ends holding the NEWEST trace's first
      // gist for each tool.
      newestGist.set(step.tool, step.gist);
    }
  }

  return firstSeen
    .filter((tool) => (traceCount.get(tool) ?? 0) >= majority)
    .slice(0, MAX_BACKBONE_STEPS)
    .map((tool) => ({ tool, gist: generalizeGist(newestGist.get(tool) ?? "") }));
}

/** One accepted draft feeding a proposal (oldest → newest order expected). */
export interface ProposalSourceDraft {
  id: string;
  runId: string;
  title: string;
  /** The draft's executable trace (evidence.procedure); absent on pre-feature
   *  drafts, in which case assembly falls back to the generic text. */
  procedure?: ProcedureTraceStep[];
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
 * procedure); the sections record provenance (which learnings, which runs).
 * When the drafts carry procedure traces the Procedure section is their common
 * ordered backbone (the executable playbook the runs actually followed); when
 * none do, it falls back to pointing the agent at the accepted knowledge,
 * honestly labeled as assembled rather than hand-authored. Pure.
 */
export function assembleSkillProposal(drafts: ProposalSourceDraft[]): AssembledSkillProposal {
  const newest = drafts[drafts.length - 1];
  if (!newest) throw new Error("assembleSkillProposal requires at least one draft");
  const topic = topKeywords(drafts.map((d) => d.title));
  const backbone = procedureBackbone(drafts.map((d) => d.procedure ?? []));
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
      procedure:
        backbone.length > 0
          ? [
              ...backbone.map((s) => (s.gist ? `${s.tool}: ${s.gist}` : s.tool)),
              "This is the ordered backbone shared by the source runs. Adapt file paths, repo names, and parameters to the current task.",
            ]
          : [
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
