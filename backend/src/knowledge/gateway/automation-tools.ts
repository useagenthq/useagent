import type { ToolCallResult } from "./tools";
import type { GatewayToolDescriptor } from "./descriptor";
import { errorResult, textResult } from "./tool-results";
import {
  argumentsWithoutApproval,
  consumeApprovalCapability,
  type ApprovalCapabilityStore,
} from "./approval-capability";
import { mintToolToken, type ToolTokenClaims } from "./token";
import {
  AUTOMATION_CONTRACT,
  AUTOMATION_TOOL_NAMES,
  AUTOMATION_TOOLS as AUTOMATION_TOOL_CATALOG,
} from "./automation-tool-catalog";
import { getRunForOrg } from "../../runs/repo";
import { getScheduleForOrg, listFirings, listSchedules, type ApiFiring, type ApiSchedule, type ScheduleRecord } from "../../schedules/repo";
import {
  createScheduleForOrg,
  deleteScheduleForOrg,
  ScheduleServiceError,
  updateScheduleForOrg,
} from "../../schedules/service";

export { AUTOMATION_TOOL_NAMES };

export const AUTOMATION_APPROVAL_REQUIRED_TOOL_NAMES: ReadonlySet<string> = new Set([
  "automation_update",
  "automation_run_now",
  "automation_delete",
]);

const APPROVAL_CAPABILITY_SCHEMA = {
  type: "string",
  description:
    "Opaque, short-lived, one-shot capability minted by the authenticated useAgent backend for this exact tool and argument object after user approval.",
} as const;

export const AUTOMATION_TOOLS: readonly GatewayToolDescriptor[] = AUTOMATION_TOOL_CATALOG.map((tool) => {
  if (!AUTOMATION_APPROVAL_REQUIRED_TOOL_NAMES.has(tool.name)) return tool;
  const schema = tool.inputSchema as {
    readonly properties: Readonly<Record<string, unknown>>;
    readonly required?: readonly string[];
  };
  const properties = { ...schema.properties };
  delete properties.confirmEnable;
  return {
    ...tool,
    description:
      `${tool.description} This operation requires a server-minted one-shot approval capability bound to these exact arguments.`,
    inputSchema: {
      ...tool.inputSchema,
      properties: { ...properties, approvalCapability: APPROVAL_CAPABILITY_SCHEMA },
      required: [...new Set([...(schema.required ?? []), "approvalCapability"])],
    },
  };
});

const APPROVAL_AUTOMATION_CONTRACT = {
  ...AUTOMATION_CONTRACT,
  enable:
    "automation_update requires a server-minted, short-lived, one-shot approval capability bound to the exact run, tool, and normalized arguments",
} as const;

const MAX_TEXT_FIRINGS = 20;
const MAX_TEXT_SUMMARY_CHARS = 240;

export interface AutomationToolExecutionOptions {
  readonly approvalStore?: ApprovalCapabilityStore;
  readonly nowMs?: number;
}

function serviceError(error: ScheduleServiceError): ToolCallResult {
  const body =
    error.body.error === "schedule not found"
      ? { ...error.body, error: "automation not found" }
      : error.body;
  return errorResult(String(body.error ?? error.message), {
    status: error.status,
    error: body,
  });
}

function automationNotFound(): ToolCallResult {
  return errorResult("automation not found", { status: 404 });
}

function promptPreview(prompt: string): string {
  return prompt.length <= 160 ? prompt : `${prompt.slice(0, 157)}...`;
}

function firingSummaryPreview(summary: string | null): {
  readonly text: string;
  readonly truncated: boolean;
} {
  if (summary === null) return { text: "null", truncated: false };
  const normalized = summary.replace(/\s+/g, " ").trim();
  const serialized = JSON.stringify(normalized);
  if (serialized.length <= MAX_TEXT_SUMMARY_CHARS) {
    return { text: serialized, truncated: false };
  }
  let low = 0;
  let high = normalized.length;
  let text = JSON.stringify("");
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = JSON.stringify(normalized.slice(0, middle));
    if (candidate.length <= MAX_TEXT_SUMMARY_CHARS) {
      text = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return { text, truncated: true };
}

export function formatAutomationHistoryText(
  schedule: Pick<ScheduleRecord, "id" | "name">,
  firings: readonly ApiFiring[],
): string {
  const shownFirings = firings.slice(0, MAX_TEXT_FIRINGS);
  const truncated = firings.length > shownFirings.length;
  const lines = shownFirings.map((firing) => {
    const summary = firingSummaryPreview(firing.run_summary);
    return `fired_at=${firing.fired_at} trigger=${firing.trigger} run_id=${firing.run_id} run_status=${firing.run_status ?? "null"} summary=${summary.text} summary_truncated=${summary.truncated}`;
  });
  return [
    `Automation: ${schedule.id} name=${JSON.stringify(schedule.name)}`,
    `Total: ${firings.length}; shown: ${shownFirings.length}; truncated: ${truncated}`,
    ...lines,
  ].join("\n");
}

function automationSummary(schedule: ApiSchedule | ScheduleRecord): Record<string, unknown> {
  const api = "org_id" in schedule;
  return {
    id: schedule.id,
    org_id: api ? schedule.org_id : schedule.orgId,
    user_id: api ? schedule.user_id : schedule.userId,
    name: schedule.name,
    cron: schedule.cron,
    timezone: schedule.timezone,
    prompt_preview: promptPreview(schedule.prompt),
    engine: schedule.engine,
    model: schedule.model,
    skill_id: api ? schedule.skill_id : schedule.skillId,
    skill_version: api ? schedule.skill_version : schedule.skillVersion,
    skill_content_hash: api ? schedule.skill_content_hash : schedule.skillContentHash,
    repos: schedule.repos,
    tags: schedule.tags,
    delivery: schedule.delivery,
    notifications: schedule.notifications,
    run_actor_id: api ? schedule.run_actor_id : schedule.runActorId,
    concurrency: schedule.concurrency,
    queue: schedule.queue,
    cost_limits: api ? schedule.cost_limits : schedule.costLimits,
    frequency_limits: api ? schedule.frequency_limits : schedule.frequencyLimits,
    approval_policy: api ? schedule.approval_policy : schedule.approvalPolicy,
    enablement_policy: api ? schedule.enablement_policy : schedule.enablementPolicy,
    enabled: schedule.enabled,
    last_fired_at: api
      ? schedule.last_fired_at
      : schedule.lastFiredAt?.toISOString() ?? null,
    created_at: api ? schedule.created_at : schedule.createdAt.toISOString(),
    updated_at: api ? schedule.updated_at : schedule.updatedAt.toISOString(),
  };
}

function automationId(args: Record<string, unknown>): string | null {
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
    const input = { ...args };
    if (input.engine === undefined) {
      const run = await getRunForOrg(claims.orgId, claims.runId);
      if (!run) return errorResult("Current run was not found for this automation capability.");
      input.engine = run.engine;
      if (input.model === undefined) input.model = run.model;
    }
    const schedule = await createScheduleForOrg(
      { orgId: claims.orgId, userId: claims.userId || null },
      input,
    );
    return textResult(
      `Created disabled automation ${schedule.name} (${schedule.id}). It will not run until enabled.`,
      { automation: automationSummary(schedule) },
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
  const id = automationId(args);
  if (!id) return errorResult("automation_update requires an automation id.");
  const patch = { ...args };
  delete patch.confirmEnable;
  delete patch.id;
  try {
    const schedule = await updateScheduleForOrg(claims.orgId, id, patch);
    return textResult(`Updated automation ${schedule.name} (${schedule.id}).`, {
      automation: automationSummary(schedule),
    });
  } catch (error) {
    if (error instanceof ScheduleServiceError) return serviceError(error);
    throw error;
  }
}

async function getAutomation(
  claims: ToolTokenClaims,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const id = automationId(args);
  if (!id) return errorResult("automation_get requires an automation id.");
  const schedule = await getScheduleForOrg(claims.orgId, id);
  if (!schedule) return automationNotFound();
  return textResult(`Automation ${schedule.name} (${schedule.id}).`, {
    automation: automationSummary(schedule),
  });
}

async function runAutomationNow(
  claims: ToolTokenClaims,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const id = automationId(args);
  if (!id) return errorResult("automation_run_now requires an automation id.");
  const schedule = await getScheduleForOrg(claims.orgId, id);
  if (!schedule) return automationNotFound();
  // Keep the standalone tool gateway importable without loading the backend's
  // command worker and authentication root. The execution graph is needed only
  // for this explicit mutating call.
  const { fireScheduleForOrg } = await import("../../schedules/service");
  const runId = await fireScheduleForOrg(schedule, "manual");
  return textResult(`Started automation ${schedule.name} now as run ${runId}.`, {
    run_id: runId,
    automation_id: schedule.id,
  });
}

async function automationHistory(
  claims: ToolTokenClaims,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const id = automationId(args);
  if (!id) return errorResult("automation_history requires an automation id.");
  const schedule = await getScheduleForOrg(claims.orgId, id);
  if (!schedule) return automationNotFound();
  const firings = await listFirings(schedule.id);
  return textResult(
    formatAutomationHistoryText(schedule, firings),
    { automation_id: schedule.id, firings },
  );
}

async function deleteAutomation(
  claims: ToolTokenClaims,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const id = automationId(args);
  if (!id) return errorResult("automation_delete requires an automation id.");
  try {
    await deleteScheduleForOrg(claims.orgId, id);
    return textResult(`Deleted automation ${id}.`, { automation_id: id, deleted: true });
  } catch (error) {
    if (error instanceof ScheduleServiceError) return serviceError(error);
    throw error;
  }
}

export async function executeAutomationToolLocal(
  claims: ToolTokenClaims,
  name: string,
  args: Record<string, unknown>,
  options: AutomationToolExecutionOptions = {},
): Promise<ToolCallResult> {
  const operationArgs = argumentsWithoutApproval(args);
  if (AUTOMATION_APPROVAL_REQUIRED_TOOL_NAMES.has(name)) {
    const capability =
      typeof args.approvalCapability === "string" ? args.approvalCapability : null;
    const approved = await consumeApprovalCapability(
      { capability, claims, toolName: name, arguments: operationArgs },
      options.approvalStore,
      options.nowMs,
    );
    if (!approved) {
      return errorResult(
        `A valid server-minted one-shot approval capability is required for ${name}. A run can never mint its own: call approval_request with this tool name and the exact argument object, tell the user to approve it in the useAgent session view, poll approval_poll for the returned approvalCapability, then retry ${name} with it.`,
        { error: "approval_required" },
      );
    }
  }
  if (name === "automation_list") {
    const automations = await listSchedules(claims.orgId);
    return textResult(
      automations.length === 0
        ? "No scheduled automations exist in this organization."
        : automations.map((item) => `${item.id} ${item.enabled ? "enabled" : "disabled"} ${item.cron} ${item.name}`).join("\n"),
      { automations: automations.map(automationSummary) },
    );
  }
  if (name === "automation_schema") {
    return textResult(`useAgent automation contract ${APPROVAL_AUTOMATION_CONTRACT.version}.`, {
      schema: APPROVAL_AUTOMATION_CONTRACT,
    });
  }
  if (name === "automation_get") return getAutomation(claims, operationArgs);
  if (name === "automation_create") return createAutomation(claims, operationArgs);
  if (name === "automation_update") return updateAutomation(claims, operationArgs);
  if (name === "automation_run_now") return runAutomationNow(claims, operationArgs);
  if (name === "automation_history") return automationHistory(claims, operationArgs);
  if (name === "automation_delete") return deleteAutomation(claims, operationArgs);
  return errorResult(`Unknown tool: ${name}`);
}

function primaryApiOrigin(): string | null {
  if (!process.env.GATEWAY_DATABASE_URL) return null;
  const raw = process.env.USEAGENT_API_ORIGIN?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

async function executeThroughPrimaryApi(
  origin: string,
  claims: ToolTokenClaims,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const remainingTtlMs = Math.max(1, Math.min(30_000, claims.exp - Date.now()));
  const token = mintToolToken(
    {
      orgId: claims.orgId,
      userId: claims.userId,
      threadId: claims.threadId,
      runId: claims.runId,
      scope: claims.scope,
    },
    remainingTtlMs,
  );
  const response = await fetch(`${origin}/api/internal/automation`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ name, arguments: args }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await response.json().catch(() => null)) as
    | { result?: ToolCallResult; error?: string }
    | null;
  if (!response.ok || !body?.result) {
    return errorResult(body?.error ?? `automation control plane returned HTTP ${response.status}`, {
      status: response.status,
    });
  }
  return body.result;
}

/**
 * The standalone gateway deliberately has a restricted database role and no
 * command worker. In that process, automation mutations are delegated to the
 * loopback primary API under a freshly minted, short-lived copy of the current
 * live capability. The primary re-verifies liveness and tenant identity before
 * executing. Local development and direct unit tests use the same service
 * implementation in-process.
 */
export async function executeAutomationTool(
  claims: ToolTokenClaims,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const origin = primaryApiOrigin();
  if (process.env.GATEWAY_DATABASE_URL && !origin) {
    return errorResult(
      "automation control plane is not configured; ask the workspace operator to set USEAGENT_API_ORIGIN for the gateway, then retry",
    );
  }
  return origin
    ? executeThroughPrimaryApi(origin, claims, name, args)
    : executeAutomationToolLocal(claims, name, args);
}
