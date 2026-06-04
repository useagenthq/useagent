/**
 * L1 Extraction Prompt: scene segmentation and memory extraction.
 *
 * The system prompt handles both operations in one LLM call. The user prompt
 * supplies the previous scene, context-only background, and new messages.
 */

import type { ConversationMessage } from "../conversation/l0-recorder.js";

export const EXTRACT_MEMORIES_SYSTEM_PROMPT = `# Scene Segmentation and Memory Extraction

Analyze a conversation, segment the new messages into scenes, and extract only durable core memories of type persona, episodic, or instruction.

## Output language (highest priority)

- Write every free-text value, including \`scene_name\` and memory \`content\`, in the dominant language of the user's source messages.
- English source messages must produce English free text. Legitimate Chinese source messages may produce Chinese free text.
- Do not translate memories into a different language merely because an instruction or example uses that language.
- Keep JSON field names, enum values, IDs, and ISO 8601 timestamps in English.

## Scene segmentation

- Continue the previous scene when the user's intent and goal have not materially changed.
- Start a new scene for an explicit topic change, a distinct intent, or an independent new goal.
- A batch may contain one or several scenes.
- Give each scene a unique, self-contained, single-sentence name of roughly 30-50 characters or equivalent length, such as "The AI is helping Maya plan a product launch".

## Memory extraction

Use background messages only to resolve context, references, and time. Extract memories only from the new messages, and use only new-message IDs in \`source_message_ids\`.

General rules:
1. Prefer omission over low-value extraction. Exclude small talk, temporary requests, one-off operations, duplicates, unreliable details, and the assistant's own behavior or output.
2. Each memory must remain understandable outside this conversation and clearly identify its subject.
3. Combine closely related or causal statements into one complete memory instead of fragmenting them.
4. Do not extract a purely subjective feeling unless it is part of an objective event.

Supported types:

1. \`persona\`: stable user attributes, preferences, skills, values, or habits.
   - Example: "The user (Maya) is a senior product manager based in Berlin."
   - Priority 80-100 for health constraints or core traits; 50-70 for ordinary preferences or skills; omit vague items below 50.

2. \`episodic\`: an objective action, decision, plan, or completed result, never a feeling alone.
   - State the user, the event, and an absolute time or location when known.
   - Infer absolute time from message timestamps when reliable. Put known bounds in \`activity_start_time\` and \`activity_end_time\` as ISO 8601 values.
   - Priority 80-100 for important events or plans; 60-70 for ordinary complete activities; omit trivial items below 60.

3. \`instruction\`: a durable rule for how the AI should behave, format answers, or communicate.
   - Example: "The user wants the AI to lead with a concise verdict in future reviews."
   - Priority -1 only for an explicit strict global command; 90-100 for core behavior rules; 70-80 for important durable requirements; omit temporary requirements below 70.

## JSON contract

Return only one valid JSON array, with no Markdown fence or explanation:

[
  {
    "scene_name": "A generated or inherited scene name",
    "message_ids": ["message_id_1", "message_id_2"],
    "memories": [
      {
        "content": "A complete, self-contained memory statement",
        "type": "persona|episodic|instruction",
        "priority": 80,
        "source_message_ids": ["message_id_1", "message_id_2"],
        "metadata": {}
      }
    ]
  }
]

For an episodic memory, \`metadata\` may contain \`activity_start_time\` and \`activity_end_time\`. Otherwise use \`{}\`. Even when no meaningful memory exists, return the scene segmentation with an empty \`memories\` array.`;

export type MemoryPromptMode = "chat" | "code";

export const EXTRACT_WORK_MEMORIES_SYSTEM_PROMPT = `# Work Scene Segmentation and Shared Memory Extraction

Analyze multi-person work messages, segment them into work scenes, and extract structured work memories that remain useful to a project team or future agent.

## Output language (highest priority)

- Write every free-text value, including \`scene_name\` and memory \`content\`, in the dominant language of the source messages.
- English source messages must produce English free text. Legitimate Chinese source messages may produce Chinese free text.
- Do not translate content merely because an instruction or example uses another language.
- Keep JSON field names, enum values, IDs, and ISO 8601 timestamps in English.

## Work scene segmentation

A scene groups messages about the same project, task, module, requirement, problem, decision, incident, customer case, deliverable, or work goal.

- Continue the previous scene while the same work object and goal continue.
- Start a new scene when the work object changes, the goal materially changes, or a separate task, decision, or investigation begins.
- Split sequentially discussed independent work topics into separate scenes.
- Name scenes around the work object in one unique sentence of roughly 30-50 characters or equivalent length, such as "The team is diagnosing Billing API timeouts".

## Shared work memory extraction

Use background messages only for context, references, and time. Extract only from new messages, and use only new-message IDs in \`source_message_ids\`.

Rules:
1. Extract information that helps teammates or agents understand context, continue work, reuse a method, or avoid a repeated mistake.
2. Include only work information suitable for team sharing. Exclude unrelated personal preferences, private life, sensitive information, small talk, temporary emotions, and one-off tool requests.
3. Make each memory self-contained, with a clear subject, work object, conclusion, state, or method. Avoid context-dependent references such as "this" or "the above".
4. Attribute claims accurately. A person's suggestion is not a team decision until explicitly accepted. Describe unconfirmed proposals or risks as unconfirmed.
5. Merge strongly related statements, but keep distinct work objects, tasks, and methods separate.
6. Do not treat AI suggestions as team facts. Extract agent output only when a human accepts it or when it is a concrete tool result, deliverable, or experiment result used as a work asset.

Supported types:

1. \`work_fact\`: project, system, business, customer, requirement, decision, state, risk, constraint, experiment result, or term definition.
   - Priority 90-100 for key decisions, requirements, durable constraints, or major risks; 70-89 for generally useful facts; omit low-impact facts below 70.

2. \`work_task\`: an action item, owner assignment, deadline, follow-up, blocker, next step, or status change.
   - Priority 90-100 for delivery blockers, deadlines, or critical-path work; 70-89 for tasks with a clear owner or action; omit vague temporary tasks below 70.
   - Metadata may contain \`owner\`, ISO 8601 \`deadline\`, and \`status\` from \`todo|doing|done|blocked|deferred|cancelled\`.

3. \`work_method\`: a reusable SOP, process, principle, constraint, anti-pattern, design rationale, lesson, evaluation rule, agent rule, or prompt-writing rule.
   - Priority 90-100 for stable cross-task methods affecting agent or team behavior; 70-89 for methods reusable in the current project; omit one-off methods below 70.
   - Metadata may contain \`scope\` from \`project|team|module|agent|workflow\` and \`method_type\` from \`sop|principle|constraint|anti_pattern|heuristic|evaluation_criterion\`.

4. \`work_artifact\`: a document, PR, issue, branch, design, report, repository, dataset, meeting note, prompt, link, or accepted agent-generated deliverable.
   - Priority 90-100 for critical assets; 70-89 for reusable assets; omit temporary files or unaccepted drafts below 70.
   - Metadata may contain \`artifact_type\` from \`doc|pr|issue|repo|branch|design|report|prompt|dataset|meeting_note\` and \`artifact_ref\`.

## JSON contract

Return only one valid JSON array, with no Markdown fence or explanation:

[
  {
    "scene_name": "A generated or inherited work scene name",
    "message_ids": ["message_id_1", "message_id_2"],
    "memories": [
      {
        "content": "A complete, self-contained work memory suitable for team sharing",
        "type": "work_fact|work_task|work_method|work_artifact",
        "priority": 80,
        "source_message_ids": ["message_id_1", "message_id_2"],
        "metadata": {}
      }
    ]
  }
]

All types may use empty metadata. \`work_fact\` metadata may also contain \`work_object\`, \`status\`, \`activity_start_time\`, and \`activity_end_time\`. Do not include unrelated personal information in metadata. Even when no meaningful shared work memory exists, return the scene segmentation with an empty \`memories\` array.`;

export function getExtractMemoriesSystemPrompt(mode: MemoryPromptMode = "chat"): string {
  return mode === "code" ? EXTRACT_WORK_MEMORIES_SYSTEM_PROMPT : EXTRACT_MEMORIES_SYSTEM_PROMPT;
}

export function formatExtractionPrompt(params: {
  newMessages: ConversationMessage[];
  backgroundMessages?: ConversationMessage[];
  previousSceneName?: string;
}): string {
  const { newMessages, backgroundMessages = [], previousSceneName = "None" } = params;

  const bgText = backgroundMessages.length > 0
    ? backgroundMessages
        .map((m) => `[${m.id}] [${m.role}] [${new Date(m.timestamp).toISOString()}]: ${m.content}`)
        .join("\n\n")
    : "None";

  const newText = newMessages
    .map((m) => `[${m.id}] [${m.role}] [${new Date(m.timestamp).toISOString()}]: ${m.content}`)
    .join("\n\n");

  return `**Output language**: Write \`scene_name\` and memory \`content\` in the dominant language of the user statements in New Messages. English input must remain English; legitimate Chinese input may remain Chinese.

## Previous Scene
${previousSceneName}

## Background Conversation
Context only. Never extract memories from this section.

${bgText}

---

## New Messages
Use timestamps to resolve time. Extract memories only from this section.

${newText}`;
}
