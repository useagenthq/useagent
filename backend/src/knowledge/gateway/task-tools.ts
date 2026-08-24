import { TASK_STATUSES, type TaskStatus } from "../../db/schema";
import { getRunForOrg } from "../../runs/repo";
import {
  createTask,
  getTaskForOrg,
  listTasksForOrg,
  updateTask,
  type TaskRecord,
} from "../../tasks/repo";
import type { ToolTokenClaims } from "./token";
import type { ToolCallResult } from "./tools";

// ---------------------------------------------------------------------------
// Durable task gateway (Tier-2). An agent mid-run creates and updates ORG-SCOPED
// tasks that OUTLIVE the session - the durability win over an in-sandbox / MCP
// task server whose state dies with the process. Identity, org, and the default
// project are derived SERVER-side from the run-scoped token (never a tool
// argument): a tampered token fails closed upstream, and every read/write is
// pinned to the token's org. `project` defaults to the run's primary repo.
// ---------------------------------------------------------------------------

export const TASK_TOOLS = [
  {
    name: "task_create",
    description:
      "Create a durable task in this organization's task board. The task persists after this run ends " +
      "(it outlives the session), so use it to record follow-up work, a plan item, or a TODO the team " +
      "should see later. The project defaults to this run's repository; pass `project` to file it elsewhere.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short task title (required)." },
        body: { type: "string", description: "Optional longer description / notes." },
        status: {
          type: "string",
          enum: [...TASK_STATUSES],
          description: "Initial column. Defaults to 'todo'.",
        },
        priority: { type: "integer", description: "Optional priority (higher = more urgent)." },
        project: {
          type: "string",
          description:
            "Project key to file under - a repo full name ('owner/name') or a free label. " +
            "Defaults to this run's primary repository.",
        },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: "task_list",
    description:
      "List this organization's durable tasks. By default lists this run's repository (project); pass " +
      "`project` to list another, or omit the default by passing an empty `project`. Optionally filter " +
      "by `status`.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description:
            "Project key to list. Defaults to this run's primary repository; pass an explicit value to " +
            "list another project.",
        },
        status: {
          type: "string",
          enum: [...TASK_STATUSES],
          description: "Optional status filter.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "task_update",
    description:
      "Update one durable task by id (from task_list) - transition its status, edit the title/body, or " +
      "change its priority. Org-scoped: a task from another organization is not found.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Exact task id returned by task_list." },
        status: {
          type: "string",
          enum: [...TASK_STATUSES],
          description: "New column, e.g. 'in_progress' or 'done'.",
        },
        title: { type: "string", description: "New title." },
        body: { type: "string", description: "New description / notes." },
        priority: { type: "integer", description: "New priority." },
      },
      required: ["taskId"],
      additionalProperties: false,
    },
  },
] as const;

export const TASK_TOOL_NAMES: ReadonlySet<string> = new Set(TASK_TOOLS.map((tool) => tool.name));

function error(text: string): ToolCallResult {
  return { content: [{ type: "text", text }], isError: true };
}

function summarizeTask(t: TaskRecord): Record<string, unknown> {
  return {
    id: t.id,
    project: t.projectKey,
    title: t.title,
    body: t.body,
    status: t.status,
    priority: t.priority,
  };
}

/** The run's primary repository ("owner/name"), or null - the default project a
 *  mid-run task is filed under when the agent passes no explicit `project`. */
async function runPrimaryProject(claims: ToolTokenClaims): Promise<string | null> {
  const run = await getRunForOrg(claims.orgId, claims.runId);
  return run?.repo ?? null;
}

/** Resolve the effective project: an explicit non-empty arg wins; an explicit
 *  empty string means "unfiled"; an absent arg falls back to the run's repo. */
function resolveProject(
  arg: unknown,
  fallback: string | null,
): { value: string | null; explicit: boolean } {
  if (typeof arg === "string") {
    const trimmed = arg.trim();
    return { value: trimmed ? trimmed : null, explicit: true };
  }
  return { value: fallback, explicit: false };
}

function coerceStatus(arg: unknown): TaskStatus | null | undefined {
  if (arg === undefined) return undefined;
  return typeof arg === "string" && (TASK_STATUSES as readonly string[]).includes(arg)
    ? (arg as TaskStatus)
    : null;
}

async function createTaskTool(
  claims: ToolTokenClaims,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const title = typeof args.title === "string" ? args.title.trim() : "";
  if (!title) return error("task_create requires a non-empty `title`.");

  const status = coerceStatus(args.status);
  if (status === null) {
    return error(`task_create: status must be one of: ${TASK_STATUSES.join(", ")}.`);
  }

  const { value: project } = resolveProject(args.project, await runPrimaryProject(claims));
  const created = await createTask({
    orgId: claims.orgId,
    projectKey: project,
    title,
    body: typeof args.body === "string" ? args.body : null,
    status: status ?? undefined,
    priority: typeof args.priority === "number" ? args.priority : undefined,
    createdByUserId: claims.userId || null,
    // Provenance: the run that created this durable task.
    sourceRunId: claims.runId,
  });

  return {
    content: [
      {
        type: "text",
        text: `Created durable task "${created.title}" (${created.status}) in project ${created.projectKey ?? "(none)"}. Task id: ${created.id}.`,
      },
    ],
    structuredContent: { task: summarizeTask(created) },
  };
}

async function listTasksTool(
  claims: ToolTokenClaims,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const statusFilter = coerceStatus(args.status);
  if (statusFilter === null) {
    return error(`task_list: status must be one of: ${TASK_STATUSES.join(", ")}.`);
  }
  const { value: project } = resolveProject(args.project, await runPrimaryProject(claims));
  const rows = await listTasksForOrg(claims.orgId, project ?? undefined);
  const filtered = statusFilter ? rows.filter((t) => t.status === statusFilter) : rows;

  const tasks = filtered.map(summarizeTask);
  const header = project
    ? `Tasks for project ${project}`
    : args.project !== undefined
      ? "Unfiled tasks"
      : "Tasks (all projects)";
  const lines = filtered.length
    ? filtered.map((t) => `- [${t.status}] ${t.title} (id ${t.id})`).join("\n")
    : "(no tasks)";

  return {
    content: [{ type: "text", text: `${header}:\n${lines}` }],
    structuredContent: { tasks },
  };
}

async function updateTaskTool(
  claims: ToolTokenClaims,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const taskId = typeof args.taskId === "string" ? args.taskId.trim() : "";
  if (!taskId) return error("task_update requires an exact `taskId` from task_list.");

  const status = coerceStatus(args.status);
  if (status === null) {
    return error(`task_update: status must be one of: ${TASK_STATUSES.join(", ")}.`);
  }

  const patch: {
    title?: string;
    body?: string | null;
    status?: TaskStatus;
    priority?: number;
  } = {};
  if (typeof args.title === "string" && args.title.trim()) patch.title = args.title.trim();
  if (typeof args.body === "string") patch.body = args.body;
  if (status !== undefined) patch.status = status;
  if (typeof args.priority === "number") patch.priority = args.priority;

  if (Object.keys(patch).length === 0) {
    // Nothing to change: confirm the task exists (org-scoped) so the agent gets
    // a not-found signal rather than a silent no-op on a stale id.
    const current = await getTaskForOrg(claims.orgId, taskId);
    if (!current) return error("That task is not available to this organization.");
    return {
      content: [{ type: "text", text: `No changes provided for task ${taskId}.` }],
      structuredContent: { task: summarizeTask(current) },
    };
  }

  const updated = await updateTask(claims.orgId, taskId, patch);
  if (!updated) return error("That task is not available to this organization.");
  return {
    content: [
      { type: "text", text: `Updated task "${updated.title}" - now ${updated.status}.` },
    ],
    structuredContent: { task: summarizeTask(updated) },
  };
}

export async function executeTaskTool(
  claims: ToolTokenClaims,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (name === "task_create") return createTaskTool(claims, args);
  if (name === "task_list") return listTasksTool(claims, args);
  if (name === "task_update") return updateTaskTool(claims, args);
  return error(`Unknown tool: ${name}`);
}
