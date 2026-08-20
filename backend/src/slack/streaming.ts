import type { CardPhase } from "./card";

export type SlackStreamTaskDisplayMode = "task_update" | "plan";
export type SlackSessionStatus = "processing" | "active";
export type SlackTaskUpdateStatus = "in_progress" | "complete" | "error";
export type SlackPlanTaskStatus = "pending" | "in_progress" | "complete" | "error";

export type SlackMarkdownStreamChunk = {
  readonly type: "markdown_text";
  readonly markdown_text: string;
};

export type SlackTaskUpdateStreamChunk = {
  readonly type: "task_update";
  readonly task: {
    readonly task_id: string;
    readonly title: string;
    readonly status: SlackTaskUpdateStatus;
    readonly output?: {
      readonly type: "rich_text";
      readonly elements: readonly unknown[];
    };
    readonly sources?: readonly unknown[];
  };
};

export type SlackPlanStreamChunk = {
  readonly type: "task";
  readonly id: string;
  readonly text: string;
  readonly status: SlackPlanTaskStatus;
};

export type SlackStreamChunk = SlackMarkdownStreamChunk | SlackTaskUpdateStreamChunk | SlackPlanStreamChunk;

const STREAM_TEXT_CAP = 2_900;
const TASK_TITLE_CAP = 180;

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function markdownChunk(text: string): SlackMarkdownStreamChunk {
  return { type: "markdown_text", markdown_text: truncate(text, STREAM_TEXT_CAP) || " " };
}

export function taskUpdateChunk(input: {
  readonly taskId: string;
  readonly title: string;
  readonly status: SlackTaskUpdateStatus;
  readonly output?: string;
  readonly sources?: readonly unknown[];
}): SlackTaskUpdateStreamChunk {
  return {
    type: "task_update",
    task: {
      task_id: input.taskId,
      title: truncate(input.title, TASK_TITLE_CAP) || "Working",
      status: input.status,
      ...(input.output
        ? {
            output: {
              type: "rich_text",
              elements: [
                {
                  type: "rich_text_section",
                  elements: [{ type: "text", text: truncate(input.output, STREAM_TEXT_CAP) }],
                },
              ],
            },
          }
        : {}),
      ...(input.sources ? { sources: input.sources } : {}),
    },
  };
}

export function planTaskChunk(input: {
  readonly id: string;
  readonly text: string;
  readonly status: SlackPlanTaskStatus;
}): SlackPlanStreamChunk {
  return {
    type: "task",
    id: truncate(input.id, TASK_TITLE_CAP) || "task",
    text: truncate(input.text, TASK_TITLE_CAP) || "Task",
    status: input.status,
  };
}

export function openingStreamChunks(input: {
  readonly title: string;
  readonly mode: SlackStreamTaskDisplayMode;
}): readonly SlackStreamChunk[] {
  if (input.mode === "plan") {
    return [
      markdownChunk(`Planning: ${input.title}`),
      planTaskChunk({ id: "inspect", text: "Inspect request", status: "in_progress" }),
      planTaskChunk({ id: "edit", text: "Make changes", status: "pending" }),
      planTaskChunk({ id: "verify", text: "Verify and summarize", status: "pending" }),
    ];
  }
  return [
    markdownChunk(`Queued: ${input.title}`),
    taskUpdateChunk({ taskId: "run", title: input.title, status: "in_progress" }),
  ];
}

export function runningTaskChunk(step: { readonly id: string; readonly label: string }): SlackTaskUpdateStreamChunk {
  return taskUpdateChunk({
    taskId: `step_${step.id}`,
    title: step.label,
    status: "in_progress",
  });
}

export function terminalStreamChunks(input: {
  readonly phase: CardPhase;
  readonly answerText: string;
}): readonly SlackStreamChunk[] {
  const status = input.phase === "failed" ? "error" : "complete";
  return [
    taskUpdateChunk({
      taskId: "final",
      title: input.phase === "failed" ? "Run failed" : "Run completed",
      status,
      output: input.answerText,
    }),
    markdownChunk(input.answerText),
  ];
}
