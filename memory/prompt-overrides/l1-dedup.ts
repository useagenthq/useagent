/**
 * L1 Conflict Detection Prompt (batch mode).
 *
 * Compares new memories with a unified candidate pool and supports cross-type,
 * multi-target merge and update operations.
 */

import type { MemoryPromptMode } from "../../config.js";
import type { MemoryRecord, ExtractedMemory } from "../record/l1-writer.js";

const SHARED_CONFLICT_RULES = `## Output language (highest priority)

- Write \`merged_content\` in the language of the memories being consolidated. Prefer the existing candidate memory's language; when there is no candidate, preserve the new memory's language.
- English memories must produce English merged content. Legitimate Chinese memories may produce Chinese merged content.
- Do not translate content merely because an instruction or example uses another language.
- Keep JSON field names, enum values, record IDs, and ISO 8601 timestamps in English.

## Core behavior

- Compare every new memory with its related entries in the unified candidate pool.
- Semantically identical facts or events may be consolidated across memory types.
- One new memory may replace or merge several candidates through \`target_ids\`.
- For a merge or update, choose the best final \`merged_type\`.

Choose exactly one action for each new memory:
- \`store\`: it is materially new information.
- \`skip\`: an existing memory is at least as complete and the new memory adds nothing reliable.
- \`update\`: the same fact or event has been corrected, superseded, made more specific, or moved to a newer state. Preserve still-valid old details when useful.
- \`merge\`: the memories describe the same fact, event, or evolution and contain complementary, non-conflicting information. Produce one concise, non-redundant memory.

For \`merge\` and \`update\`, \`merged_timestamps\` must be the de-duplicated, sorted union of timestamps from the new memory and every targeted candidate.

## JSON contract

Return only one valid JSON array with one decision per new memory, and no Markdown or explanation:

[
  {
    "record_id": "new_memory_record_id",
    "action": "store|update|skip|merge",
    "target_ids": ["candidate_record_id_1", "candidate_record_id_2"],
    "merged_content": "Required for merge or update",
    "merged_type": "Required for merge or update",
    "merged_priority": 85,
    "merged_timestamps": ["Required for merge or update"]
  }
]

- \`target_ids\` contains every old candidate to replace or delete. It may be omitted or empty for store and skip.
- \`merged_content\`, \`merged_type\`, \`merged_priority\`, and \`merged_timestamps\` are required for merge and update and omitted for store and skip.
- \`merged_priority\` is an integer from 0 to 100. Increase it only when greater completeness or certainty justifies the increase.`;

export const CONFLICT_DETECTION_SYSTEM_PROMPT = `# Memory Conflict Detector

${SHARED_CONFLICT_RULES}

## Memory semantics

- \`persona\` and \`instruction\` usually represent stable state, preference, trait, or behavior rules. Merge complementary descriptions, skip redundant ones, and update explicit changes.
- \`episodic\` represents a dated objective event. Merge stages, causes, and results of the same event; skip exact repetitions.
- Determine identity from subject, topic, time proximity, and scene similarity, not type alone.
- Cross-type example: "The user started producing a podcast in 2018" and "The user has podcast-production experience" may consolidate when they express the same durable fact.

Allowed final types: \`persona|episodic|instruction|work_fact|work_task|work_method|work_artifact\`.

Priority guide: 80-100 for core traits or important events, 60-79 for ordinary preferences or activities, and below 60 for secondary information.`;

export const WORK_CONFLICT_DETECTION_SYSTEM_PROMPT = `# Shared Work Memory Conflict Detector

${SHARED_CONFLICT_RULES}

Retain only work information suitable for project-team sharing.

## Work memory semantics

- \`work_fact\`: project facts, requirements, decisions, states, risks, constraints, results, or customer feedback.
- \`work_task\`: action items, owners, deadlines, next steps, blockers, or task-state changes. Prefer update for owner, deadline, or status changes; merge complementary dependencies or acceptance criteria.
- \`work_method\`: reusable SOPs, constraints, principles, lessons, design rationales, evaluation standards, or agent rules. Merge complementary guidance or update to a clearer, more general rule.
- \`work_artifact\`: documents, PRs, issues, prompts, reports, branches, designs, or links. Merge or update versions, references, and uses of the same asset.
- The same project is not sufficient for consolidation. The memories must concern the same work object or evolution.
- Cross-type consolidation is allowed when the final memory clearly fits one allowed type.

Allowed final types: \`work_fact|work_task|work_method|work_artifact\`.

Priority guide: 80-100 for critical facts, tasks, methods, or assets; 60-79 for ordinary work information; below 60 for secondary information.`;

export function getConflictDetectionSystemPrompt(mode: MemoryPromptMode = "chat"): string {
  return mode === "code" ? WORK_CONFLICT_DETECTION_SYSTEM_PROMPT : CONFLICT_DETECTION_SYSTEM_PROMPT;
}

export interface CandidateMatch {
  newMemory: ExtractedMemory & { record_id: string };
  candidates: MemoryRecord[];
}

export function formatBatchConflictPrompt(matches: CandidateMatch[]): string {
  const unifiedPool = new Map<string, MemoryRecord>();
  const perMemoryCandidateIds = new Map<string, string[]>();

  for (const m of matches) {
    const candidateIds: string[] = [];
    for (const c of m.candidates) {
      if (!unifiedPool.has(c.id)) {
        unifiedPool.set(c.id, c);
      }
      candidateIds.push(c.id);
    }
    perMemoryCandidateIds.set(m.newMemory.record_id, candidateIds);
  }

  const poolList = Array.from(unifiedPool.values()).map((c) => ({
    record_id: c.id,
    content: c.content,
    type: c.type,
    priority: c.priority,
    scene_name: c.scene_name,
    timestamps: c.timestamps,
  }));

  let poolSection: string;
  if (poolList.length === 0) {
    poolSection = "## Unified Candidate Pool\n\nEmpty. Store every new memory.";
  } else {
    const poolStr = JSON.stringify(poolList, null, 2);
    poolSection = `## Unified Candidate Pool (${poolList.length} existing memories)\n\n${poolStr}`;
  }

  const memoryParts = matches.map((m, idx) => {
    const relatedIds = perMemoryCandidateIds.get(m.newMemory.record_id) ?? [];
    const relatedNote = relatedIds.length > 0
      ? JSON.stringify(relatedIds)
      : "[] (no similar candidate; use store)";

    const memStr = JSON.stringify(
      {
        record_id: m.newMemory.record_id,
        content: m.newMemory.content,
        type: m.newMemory.type,
        priority: m.newMemory.priority,
        scene_name: m.newMemory.scene_name,
      },
      null,
      2,
    );

    return `### New Memory ${idx + 1} (record_id: ${m.newMemory.record_id})\n${memStr}\n\nRelated candidate IDs: ${relatedNote}`;
  });

  const newMemoriesText = memoryParts.join("\n\n---\n\n");

  return `**Output language**: Preserve the language of the memories being consolidated. English input must remain English; legitimate Chinese input may remain Chinese.

${poolSection}

---

## New Memories to Decide (${matches.length})

${newMemoriesText}

Return one decision per new memory as the required JSON array. When a new memory has no related candidate IDs, use \`action=store\`.`;
}
