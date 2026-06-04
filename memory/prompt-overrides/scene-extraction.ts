/**
 * Scene Extraction Prompt — consolidates memories into scene blocks with the
 * read, write, and edit tools.
 *
 * The model is sandboxed to scene_blocks/. A file containing only [DELETED]
 * is removed by the caller after execution.
 */

import type { MemoryPromptMode } from "../../config.js";

export interface SceneExtractionPromptParams {
  memoriesJson: string;
  sceneSummaries: string;
  currentTimestamp: string;
  sceneCountWarning?: string;
  /** List of existing scene filenames (relative, e.g. ["work.md", "hobby.md"]) */
  existingSceneFiles?: string[];
  /** Maximum number of scene blocks allowed */
  maxScenes: number;
  /** Prompt family for L2 scene extraction (default: chat). */
  promptMode?: MemoryPromptMode;
}

export interface SceneExtractionPromptResult {
  systemPrompt: string;
  userPrompt: string;
}

const LANGUAGE_RULE = `## Output language (highest priority)

- Write all natural-language file names, section headings, summaries, and body text in the dominant language of the New Memories List.
- English memories must produce English-only scene content and English headings. Legitimate Chinese memories may produce Chinese scene content and headings.
- Do not translate content merely because an instruction or example uses another language.
- Keep META keys (\`created\`, \`updated\`, \`summary\`, \`heat\`), tool names, and control markers such as \`[DELETED]\` in English.`;

const TOOL_RULES = `## File-tool rules

1. Use \`read\` only for an existing file explicitly listed in the user prompt.
2. Use \`write\` with \`path\` and complete \`content\` to create a file or fully rewrite one.
3. Use \`edit\` with \`path\` and \`edits: [{ oldText, newText }]\` for a precise partial update.
4. Operate only on relative \`.md\` scene files in the current sandbox. Do not access checkpoints, indexes, persona.md, metadata, or other directories.
5. To delete a scene, write exactly \`[DELETED]\` to it. Empty content and markers such as \`[ARCHIVE]\` or \`[CONSOLIDATED]\` do not delete a file.
6. Never merely describe a file operation. Execute it with a tool.
7. Text output is reserved for the optional persona update signal; file contents belong in tool calls.`;

function buildSceneSystemPrompt(maxScenes: number): string {
  return `# Personal Memory Consolidation Architect

Consolidate fragmented L1 memories into coherent L2 scene documents. A scene is a durable narrative context, not a chronological list.

${LANGUAGE_RULE}

${TOOL_RULES}

## Scene limit

The final number of active scene files must not exceed ${maxScenes}. Prefer integrating into an existing scene over creating a new one. Before creating a scene, read at least the two most similar listed files when two are available and confirm that the new memories do not fit either. When at the limit, merge or reorganize existing scenes instead of creating another.

## Workflow

1. Classify each new memory by its central activity, relationship, goal, or life domain.
2. Use the summaries to find likely target scenes, then read the most relevant files before updating them.
3. Choose one operation:
   - CREATE only for a genuinely distinct, durable scene.
   - INTEGRATE when the memory belongs in an existing scene.
   - MERGE when two or more scenes substantially overlap. Read all sources, write one consolidated destination, then write \`[DELETED]\` to every obsolete source.
   - SKIP when the memory is already represented and adds no durable information.
4. Rewrite for coherence. Do not append raw memory lines. Preserve correct existing facts, reconcile conflicts, remove redundancy, and connect context, action, and result.
5. Infer implicit signals sparingly. Mark uncertainty and never invent unsupported facts.

## Heat

- New scene: \`heat: 1\`.
- Updated scene: previous heat + 1.
- Merged scene: sum of all source heats + 1.

## Scene document

Keep each file under 1500 characters when practical. Use this English template for English memories; translate only the natural-language headings and prose when the source memories use another language:

-----META-START-----
created: {{EXISTING_CREATED_TIME_OR_CURRENT_TIME}}
updated: {{CURRENT_TIME}}
summary: [30-40 word summary for indexing]
heat: [integer]
-----META-END-----

## Basic Information
[Include only useful known facts such as name, role, or location. Omit this section when empty.]

## User Core Traits
[A coherent paragraph under 100 words. Include only well-supported durable traits.]

## User Preferences
[Optional reusable explicit preferences. A concise list is allowed.]

## Implicit Signals
[Optional cautious inferences that are important but not explicit.]

## Core Narrative
[A coherent paragraph under 400 words following context -> action -> result.]

## Evolution
[Optional. Record only meaningful changes in preferences, character, or major views, with date and memory ID when available.]

## Open Questions or Conflicts
[Optional unresolved contradictions.]

## Optional L3 update request

When a major value change or cross-scene insight warrants persona regeneration, emit this exact text marker outside file content:

[PERSONA_UPDATE_REQUEST]
reason: A concise reason in the output language
[/PERSONA_UPDATE_REQUEST]`;
}

function buildWorkSceneSystemPrompt(maxScenes: number): string {
  return `# Work Memory Consolidation Architect

Consolidate L1 work memories into durable L2 project scene documents. A scene captures one coherent work object and its reusable context, not a chat transcript or status dump.

${LANGUAGE_RULE}

${TOOL_RULES}

## Scene limit

The final number of active scene files must not exceed ${maxScenes}. Prefer integrating into an existing project, module, requirement, incident, customer, decision, method, or deliverable scene. Before creating a scene, read at least the two most similar listed files when two are available. At the limit, merge or reorganize rather than create.

## Content boundary

- Include team-shareable work facts, decisions, tasks, owners, deadlines, risks, constraints, reusable methods, SOPs, anti-patterns, and important artifacts.
- Exclude personal profiles, private life, unrelated preferences, casual conversation, unsupported AI suggestions, and low-value activity logs.
- Attribute proposals, decisions, and results accurately. Do not convert a suggestion into a team decision without evidence of acceptance.
- Keep concrete project facts in L2. Promote only cross-scene operating rules to L3.

## Workflow

1. Group each new memory by its specific work object and goal.
2. Use summaries to find likely scenes and read the most relevant files before changing them.
3. CREATE only for a distinct durable work object; INTEGRATE compatible information; MERGE overlapping scenes and delete obsolete source files with \`[DELETED]\`; SKIP redundant low-value input.
4. Synthesize rather than append. Preserve provenance, separate confirmed decisions from open proposals, update task state, and reconcile conflicts.
5. Keep different work objects separate even when they belong to the same large project.

## Heat

- New scene: \`heat: 1\`.
- Updated scene: previous heat + 1.
- Merged scene: sum of all source heats + 1.

## Work scene document

Keep each file under 1500 characters when practical. Use this English template for English memories; translate only natural-language headings and prose when the source memories use another language:

-----META-START-----
created: {{EXISTING_CREATED_TIME_OR_CURRENT_TIME}}
updated: {{CURRENT_TIME}}
summary: [30-40 word summary for indexing]
heat: [integer]
-----META-END-----

## Work Object and Goal
[Identify the project, module, requirement, incident, customer case, decision, method, or deliverable and its goal.]

## Current State and Key Facts
[A concise synthesis of confirmed state, constraints, risks, and results.]

## Decisions and Rationale
[Confirmed decisions, why they were made, and their boundaries. Keep proposals explicitly unconfirmed.]

## Tasks and Ownership
[Action, owner, deadline, status, dependencies, and acceptance criteria when known.]

## Reusable Methods and Constraints
[SOPs, principles, anti-patterns, evaluation rules, and agent behavior that remain useful in this scene.]

## Important Artifacts
[Documents, PRs, issues, prompts, reports, branches, designs, datasets, or links with their purpose.]

## Evolution
[Optional meaningful changes to decisions, requirements, methods, or boundaries, with date and memory ID when available.]

## Open Questions
[Optional unresolved items affecting execution or decisions.]

## Optional L3 update request

When a stable SOP, constraint, decision rule, anti-pattern, or agent rule applies across scenes, emit this exact text marker outside file content:

[PERSONA_UPDATE_REQUEST]
reason: A concise reason in the output language
[/PERSONA_UPDATE_REQUEST]`;
}

function getSceneSystemPrompt(maxScenes: number, promptMode: MemoryPromptMode = "chat"): string {
  return promptMode === "code" ? buildWorkSceneSystemPrompt(maxScenes) : buildSceneSystemPrompt(maxScenes);
}

export function buildSceneExtractionPrompt(params: SceneExtractionPromptParams): SceneExtractionPromptResult {
  const {
    memoriesJson,
    sceneSummaries,
    currentTimestamp,
    sceneCountWarning,
    existingSceneFiles,
    maxScenes,
    promptMode = "chat",
  } = params;

  const warningSection = sceneCountWarning
    ? `\nWarning: ${sceneCountWarning}\n`
    : "";

  const fileListSection = existingSceneFiles && existingSceneFiles.length > 0
    ? `### Existing Scene Files (only these files may be read)\n${existingSceneFiles.map((f) => `- \`${f}\``).join("\n")}\n`
    : "### Existing Scene Files\nNone.\n";

  const userPrompt = `**Output language**: Use the dominant language of the New Memories List for natural-language scene content. English memories must remain English; legitimate Chinese memories may remain Chinese.
${warningSection}
### 1. New Memories List
${memoriesJson}

### 2. Existing Scene Blocks Summary
${sceneSummaries}

### 3. Current Timestamp
${currentTimestamp}

${fileListSection}`;

  return {
    systemPrompt: getSceneSystemPrompt(maxScenes, promptMode),
    userPrompt,
  };
}
