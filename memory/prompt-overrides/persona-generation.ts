/**
 * Persona Generation Prompt — generates or incrementally updates persona.md
 * from changed L2 scene content.
 */

import type { MemoryPromptMode } from "../../config.js";

export interface PersonaPromptParams {
  mode: "first" | "incremental";
  /** Prompt family for L3 generation (default: chat). */
  promptMode?: MemoryPromptMode;
  currentTime: string;
  totalProcessed: number;
  sceneCount: number;
  changedSceneCount: number;
  changedScenesContent: string;
  existingPersona?: string;
  triggerInfo?: string;
  /** @deprecated Kept for call-site compatibility; no longer used in prompt. */
  personaFilePath: string;
  /** @deprecated Kept for call-site compatibility; no longer used in prompt. */
  checkpointPath: string;
}

export interface PersonaPromptResult {
  systemPrompt: string;
  userPrompt: string;
}

const FILE_RULES = `## File operations

1. You must write the final result to \`persona.md\` with a file tool.
   - For first generation or a major rewrite, use \`write\` with \`path=persona.md\` and the complete document as \`content\`.
   - For a precise incremental change, use \`edit\` with \`path=persona.md\` and \`edits: [{ oldText, newText }]\`.
2. Operate only on \`persona.md\`. Do not read or write scene files, metadata, checkpoints, or any other file.
3. Do not call \`read\`; the full current persona, when present, is already included in the user prompt.
4. File content must contain only the final Markdown document, never analysis or commentary.`;

const PERSONA_SYSTEM_PROMPT = `# Persona Architect — Incremental Evolution Protocol

Analyze the existing persona and changed scene content, then generate or update a concise, evidence-grounded user narrative profile.

## Output language (highest priority)

- Write every natural-language part of \`persona.md\`, including the archetype, headings, labels, and body, in the dominant language of the changed scene content.
- English scene content must produce an English-only persona. Legitimate Chinese scene content may produce a Chinese persona.
- Do not translate content merely because an instruction or example uses another language.
- Keep Markdown syntax, tag syntax, and the file name \`persona.md\` unchanged.

${FILE_RULES}

## Constraints

- Keep the whole document under 2000 characters by compressing or removing low-value information.
- Use only evidence from the supplied scene content and existing persona. Never infer personal facts from workspace names, paths, system metadata, or technical environment details.
- Avoid over-inference, especially during first generation. Omit a section when evidence is insufficient.
- Synthesize a coherent narrative instead of producing a list of disconnected facts.
- Preserve valid existing information, update contradicted information, and note meaningful evolution when the evidence supports it.

## Four-layer scan

1. Base and facts: reliable identity facts, demographics, work, location, and current state.
2. Interest graph: subjects receiving time, money, or attention; distinguish active interests, passive consumption, and dormant interests.
3. Interaction protocol: communication habits, friction points, workflow preferences, and how the agent should present decisions or results.
4. Cognitive core: decision logic, tensions, durable motivations, and supported patterns that help the agent act as a useful copilot.

Look for connecting themes across domains, but do not force a theme when evidence is weak.

## Persona template

Use this English structure for English scenes. Translate only natural-language headings and prose when the source scenes use another language. Sections may be omitted or adjusted when evidence is missing.

# User Narrative Profile

> **Archetype**: [One evidence-grounded sentence.]

> **Basic Information**
> - [Reliable fact]

> **Long-term Preferences**
> - [Stable reusable preference]

## Chapter 1: Context and Current State
[A coherent account combining facts and current context.]

## Chapter 2: The Texture of Life
[A coherent account connecting interests, habits, and taste.]

## Chapter 3: Interaction and Cognitive Protocol

### 3.1 How to Communicate
[Practical guidance with evidence or rationale.]

### 3.2 How to Support Decisions
[Decision logic and useful agent behavior.]

## Chapter 4: Deep Insights and Evolution

- **Resolved tensions**: [Supported traits that seem opposed but fit together.]
- **Evolution**: [Dated meaningful changes when known.]
- **Emergent traits**:
  - \`TagName\` - [Short evidence-grounded note]

End after Chapter 4. Do not add Scene Navigation; the caller appends it automatically.`;

const TEAM_MEMORY_SYSTEM_PROMPT = `# Team Operating Doctrine Architect

Analyze the existing persona.md and changed work scene blocks, then generate or update a highly compressed operating doctrine that helps future agents judge, execute, and avoid mistakes across work contexts.

## Output language (highest priority)

- Write every natural-language part of \`persona.md\`, including headings and body, in the dominant language of the changed scene content.
- English scene content must produce an English-only document. Legitimate Chinese scene content may produce a Chinese document.
- Do not translate content merely because an instruction or example uses another language.
- Keep Markdown syntax and the file name \`persona.md\` unchanged.

${FILE_RULES}

## Boundaries

- Keep the document under 1200 characters and prefer fewer, stronger rules.
- This is not a project summary, progress log, scene index, or fact inventory.
- Do not include member personality, private preferences, private state, or emotional judgments.
- Do not invent rules unsupported by scene evidence.
- Do not retain project names, versions, task names, PRs, issues, or asset names unless they represent a genuinely reusable pattern.
- Every rule must remain understandable and actionable outside its source project.

## What to distill

- SOP: a repeatable sequence for similar future tasks.
- Principle: a durable standard the team follows.
- Decision logic: a criterion for choosing between options.
- Boundary: something agents or automation must not do.
- Anti-pattern: a behavior that causes error, memory pollution, or poor quality.
- Agent rule: a default execution or output behavior.

Before including an item, verify that it is general, self-contained, actionable, stable, and expressed as concisely as possible. If any condition fails, omit it.

## Incremental strategy

- Reinforce: compress corroborating evidence into an existing rule or make no change.
- Add: include a new reusable SOP, boundary, decision rule, anti-pattern, or agent rule.
- Correct: revise a rule contradicted or narrowed by new evidence.
- Refactor: rewrite when the doctrine has become long, fragmented, or project-specific.
- No change: do not update for ordinary project facts, task progress, or low-level details.

## Doctrine template

Use this English structure for English scenes. Translate only natural-language headings and prose when the source scenes use another language. Sections may be omitted.

# Team Operating Doctrine

> **Operating Thesis**: [The most important general working or agent-execution principle.]

## Core Principles
- **Principle**: [Applicable condition, judgment, and rationale.]

## Reusable SOPs
- **SOP name**: When [trigger], first [step], then [step], and finish with [output or acceptance standard].

## Decision Logic
- When [condition], prefer [A] over [B] because [reason].

## Boundaries and Anti-patterns
- Do not [bad behavior]; instead [recommended behavior] because [reason].

## Agent Rules
- Agents should [default behavior] to avoid [risk].

> **Last updated**: [current time] · **Source scenes**: [scene count] · **Total memories**: [memory count]

Do not add Scene Navigation; the caller appends it automatically.`;

export function buildPersonaPrompt(params: PersonaPromptParams): PersonaPromptResult {
  const {
    mode,
    promptMode = "chat",
    currentTime,
    totalProcessed,
    sceneCount,
    changedSceneCount,
    changedScenesContent,
    existingPersona,
    triggerInfo,
  } = params;

  const isCodeMode = promptMode === "code";
  const targetFile = "persona.md";
  const modeLabel = mode === "first" ? "First generation" : "Incremental update";

  const triggerSection = triggerInfo
    ? `\n### Trigger Information\n${triggerInfo}\n`
    : "";

  const existingPersonaSection = existingPersona
    ? isCodeMode
      ? `\n## Current Team Operating Doctrine (preloaded)\n\n` +
        `The following is the complete current persona.md (${existingPersona.length} characters). Keep the updated document under 1200 characters:\n\n` +
        `\`\`\`markdown\n${existingPersona}\n\`\`\`\n\n---\n`
      : `\n## Current Persona (preloaded)\n\n` +
        `The following is the complete current persona.md (${existingPersona.length} characters). Keep the updated document under 2000 characters:\n\n` +
        `\`\`\`markdown\n${existingPersona}\n\`\`\`\n\n---\n`
    : "";

  const iterationGuide = mode === "incremental"
    ? isCodeMode
      ? `\n## Incremental Decision Guide\nChoose among reinforce, add, correct, refactor, or no change. Do not update the doctrine for project status or low-level facts alone.\n`
      : `\n## Incremental Decision Guide\nChoose among reinforce, add, correct, refactor, or no change based on whether the changed scenes add reliable persona evidence.\n`
    : "";

  const userPrompt = `**Output language**: Write \`${targetFile}\` in the dominant language of Changed Scene Content. English scenes must remain English; legitimate Chinese scenes may remain Chinese.

**Updated at**: ${currentTime}
**Mode**: ${modeLabel}
${triggerSection}
## Statistics
- **Total memories**: ${totalProcessed}
- **Total scenes**: ${sceneCount}
- **Changed scenes since last update**: ${changedSceneCount}

---

## Changed Scene Content
${changedScenesContent}

${existingPersonaSection}
${iterationGuide}`;

  return {
    systemPrompt: isCodeMode ? TEAM_MEMORY_SYSTEM_PROMPT : PERSONA_SYSTEM_PROMPT,
    userPrompt,
  };
}
