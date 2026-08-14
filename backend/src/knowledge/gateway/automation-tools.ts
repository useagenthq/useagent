import type { ToolCallResult } from "./tools";
import type { ToolTokenClaims } from "./token";
import { getScheduleForOrg, listFirings, listSchedules } from "../../schedules/repo";
import {
  createScheduleForOrg,
  deleteScheduleForOrg,
  ScheduleServiceError,
  updateScheduleForOrg,
} from "../../schedules/service";

export const AUTOMATION_TOOLS = [
  {
    name: "automation_list",
    description:
      "List this organization's Skynet scheduled automations. Use this for user requests about existing automations or recurring tasks. Identity is taken only from the gateway token.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "automation_create",
    description:
      "Create a Skynet scheduled automation in this organization. New automations are always created disabled and never auto-run until automation_update enables them. Use this for workspace recurring-task requests.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Human-readable automation name." },
        cron: { type: "string", description: "Five-field cron expression." },
        timezone: { type: "string", description: "Optional IANA timezone, for example Asia/Kolkata." },
        prompt: { type: "string", description: "Prompt to run when the automation fires." },
        engine: { type: "string", description: "Optional Skynet engine id." },
        model: { type: "string", description: "Optional model id allowed for the selected engine." },
      },
      required: ["name", "cron", "prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "automation_update",
    description:
      "Update one existing Skynet automation in this organization. To set enabled=true, the user must have explicitly asked to enable or activate the automation and confirmEnable must be true.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Automation id returned by automation_list/create." },
        name: { type: "string" },
        cron: { type: "string" },
        timezone: { type: ["string", "null"], description: "IANA timezone, or null/empty string to clear." },
        prompt: { type: "string" },
        engine: { type: "string" },
        model: { type: "string" },
        enabled: { type: "boolean" },
        confirmEnable: {
          type: "boolean",
          description: "Required true only when enabling after an explicit user request.",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "automation_run_now",
    description:
      "Manually run one existing Skynet automation now. This creates a durable run and records a manual firing in the automation history.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Automation id returned by automation_list/create." },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "automation_history",
    description:
      "Read firing history for one Skynet automation in this organization, including linked run status.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Automation id returned by automation_list/create." },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "automation_delete",
    description:
      "Delete one Skynet automation in this organization and its firing projection rows. Use for cleanup of test or obsolete automations.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Automation id returned by automation_list/create." },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
] as const;

export const AUTOMATION_TOOL_NAMES: ReadonlySet<string> = new Set(
  AUTOMATION_TOOLS.map((tool) => tool.name),
);

function textResult(text: string, structuredContent?: Record<string, unknown>): ToolCallResult {
  return { content: [{ type: "text", text }], structuredContent };
}

function errorResult(text: string, structuredContent?: Record<string, unknown>): ToolCallResult {
  return { content: [{ type: "text", text }], structuredContent, isError: true };
}

function serviceError(error: ScheduleServiceError): ToolCallResult {
  return errorResult(String(error.body.error ?? error.message), {
    status: error.status,
    error: error.body,
  });
}

function scheduleId(args: Record<string, unknown>): string | null {
  const id = typeof args.id === "string" ? args.id.trim() : "";
  return id || null;
}

async function createAutomation(
  claims: ToolTokenClaims,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  if ("enabled" in args) {
    return errorResult("automation_create always creates disabled automations; enable later with automation_update.");
  }
  try {
    const schedule = await createScheduleForOrg(
      { orgId: claims.orgId, userId: claims.userId || null },
      args,
    );
    return textResult(
      `Created disabled automation ${schedule.name} (${schedule.id}). It will not run until enabled.`,
      { automation: schedule },
    );
  } catch (error) {
    if (error instanceof ScheduleServiceError) return serviceError(error);
    throw error;
  }
}

async function updateAutomation(
  claims: ToolTokenClaims,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const id = scheduleId(args);
  if (!id) return errorResult("automation_update requires an automation id.");
  if (args.enabled === true && args.confirmEnable !== true) {
    return errorResult("Refusing to enable automation without confirmEnable=true after an explicit user request.");
  }
  const patch = { ...args };
  delete patch.confirmEnable;
  delete patch.id;
  try {
    const schedule = await updateScheduleForOrg(claims.orgId, id, patch);
    return textResult(`Updated automation ${schedule.name} (${schedule.id}).`, {
      automation: schedule,
    });
  } catch (error) {
    if (error instanceof ScheduleServiceError) return serviceError(error);
    throw error;
  }
}

async function runAutomationNow(
  claims: ToolTokenClaims,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const id = scheduleId(args);
  if (!id) return errorResult("automation_run_now requires an automation id.");
  const schedule = await getScheduleForOrg(claims.orgId, id);
  if (!schedule) return errorResult("schedule not found", { status: 404 });
  // Keep the standalone tool gateway importable without loading the backend's
  // command worker and authentication root. The execution graph is needed only
  // for this explicit mutating call.
  const { fireSchedule } = await import("../../schedules/fire");
  const runId = await fireSchedule(schedule, "manual");
  return textResult(`Started automation ${schedule.name} now as run ${runId}.`, {
    run_id: runId,
    automation_id: schedule.id,
  });
}

async function automationHistory(
  claims: ToolTokenClaims,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const id = scheduleId(args);
  if (!id) return errorResult("automation_history requires an automation id.");
  const schedule = await getScheduleForOrg(claims.orgId, id);
  if (!schedule) return errorResult("schedule not found", { status: 404 });
  const firings = await listFirings(schedule.id);
  return textResult(
    firings.length === 0
      ? `Automation ${schedule.name} has no firing history.`
      : `Automation ${schedule.name} has ${firings.length} firing(s).`,
    { automation_id: schedule.id, firings },
  );
}

async function deleteAutomation(
  claims: ToolTokenClaims,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const id = scheduleId(args);
  if (!id) return errorResult("automation_delete requires an automation id.");
  try {
    await deleteScheduleForOrg(claims.orgId, id);
    return textResult(`Deleted automation ${id}.`, { automation_id: id, deleted: true });
  } catch (error) {
    if (error instanceof ScheduleServiceError) return serviceError(error);
    throw error;
  }
}

export async function executeAutomationTool(
  claims: ToolTokenClaims,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (name === "automation_list") {
    const automations = await listSchedules(claims.orgId);
    return textResult(
      automations.length === 0
        ? "No scheduled automations exist in this organization."
        : automations.map((item) => `${item.id} ${item.enabled ? "enabled" : "disabled"} ${item.cron} ${item.name}`).join("\n"),
      { automations },
    );
  }
  if (name === "automation_create") return createAutomation(claims, args);
  if (name === "automation_update") return updateAutomation(claims, args);
  if (name === "automation_run_now") return runAutomationNow(claims, args);
  if (name === "automation_history") return automationHistory(claims, args);
  if (name === "automation_delete") return deleteAutomation(claims, args);
  return errorResult(`Unknown tool: ${name}`);
}
