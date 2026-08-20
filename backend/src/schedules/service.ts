import {
  ENGINE_IDS,
  type AutomationJson,
  type EngineId,
  type ScheduleTrigger,
} from "../db/schema";
import {
  removeFromContextIndex,
  syncAutomationToContextIndex,
} from "../context/projector";
import { unknownRepos } from "../github/repos";
import {
  engineModelReadyForDispatch,
  engineResolutionErrorBody,
  resolveAcceptedEngine,
} from "../runs/engine-readiness";
import { defaultModelForEngine, isModelAllowedForEngine } from "../runs/model-policy";
import { publishOrgChange, type OrgChange } from "../runs/org-signals";
import { automationSlackConfigError } from "../slack/automation";
import { resolveSkillSelection } from "../skills/repo";
import { isValidCron, isValidTimezone } from "./cron";
import {
  createSchedule,
  deleteSchedule,
  getScheduleForOrg,
  updateSchedule,
  type ApiSchedule,
  type ScheduleRecord,
} from "./repo";

type AutomationChange = Extract<OrgChange, { readonly type: "automation" }>;

function publishAutomationChange(orgId: string, change: AutomationChange): void {
  publishOrgChange(orgId, change);
}

export class ScheduleServiceError extends Error {
  readonly status: 400 | 403 | 404;
  readonly body: Record<string, unknown>;

  constructor(status: 400 | 403 | 404, body: Record<string, unknown>) {
    super(String(body.error ?? "schedule_error"));
    this.status = status;
    this.body = body;
  }
}

function textField(body: Record<string, unknown>, name: string): string {
  return typeof body[name] === "string" ? body[name].trim() : "";
}

function isPlainObject(value: unknown): value is AutomationJson {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function jsonObjectField(
  body: Record<string, unknown>,
  name: string,
): AutomationJson | null | undefined {
  const value = body[name];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!isPlainObject(value)) {
    throw new ScheduleServiceError(400, { error: `${name} must be an object or null` });
  }
  return value;
}

function stringArrayField(
  body: Record<string, unknown>,
  name: string,
): string[] | undefined {
  const value = body[name];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new ScheduleServiceError(400, { error: `${name} must be an array of strings` });
  }
  const values = value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
  if (values.length !== value.length) {
    throw new ScheduleServiceError(400, { error: `${name} must be an array of non-empty strings` });
  }
  return [...new Set(values)];
}

async function parseRepos(body: Record<string, unknown>): Promise<string[] | undefined> {
  const repos = stringArrayField(body, "repos");
  if (repos === undefined) return undefined;
  if (repos.length > 0) {
    const unknown = await unknownRepos(repos);
    if (unknown.length > 0) {
      throw new ScheduleServiceError(400, {
        error: `repos not in the available set: ${unknown.join(", ")}`,
      });
    }
  }
  return repos;
}

async function parseSkillPin(
  orgId: string,
  value: unknown,
): Promise<{
  skillId: string | null;
  skillVersion: number | null;
  skillContentHash: string | null;
} | undefined> {
  if (value === undefined) return undefined;
  if (value === null) {
    return { skillId: null, skillVersion: null, skillContentHash: null };
  }
  if (!isPlainObject(value)) {
    throw new ScheduleServiceError(400, { error: "skill must be an object or null" });
  }
  const rawId = typeof value.id === "string" ? value.id.trim() : "";
  if (!rawId) throw new ScheduleServiceError(400, { error: "skill.id must be a skill id string" });
  const version =
    typeof value.version === "number" && Number.isInteger(value.version) && value.version > 0
      ? value.version
      : undefined;
  const pinned = await resolveSkillSelection(orgId, { id: rawId, version });
  if (!pinned) {
    throw new ScheduleServiceError(400, {
      error: "skill not found in this org (or unknown version)",
    });
  }
  return {
    skillId: pinned.skillId,
    skillVersion: pinned.version,
    skillContentHash: pinned.contentHash,
  };
}

function parseTimezone(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const timezone = typeof value === "string" ? value.trim() : "";
  if (!isValidTimezone(timezone)) {
    throw new ScheduleServiceError(400, { error: "timezone must be a valid IANA name" });
  }
  return timezone;
}

function resolveReadyEngine(rawEngine: unknown): EngineId {
  const resolved = resolveAcceptedEngine(rawEngine);
  if (!resolved.ok) {
    throw new ScheduleServiceError(resolved.status, engineResolutionErrorBody(resolved));
  }
  return resolved.engine;
}

function resolveDraftEngine(rawEngine: unknown): EngineId {
  if (rawEngine === undefined || rawEngine === null || rawEngine === "") {
    return resolveReadyEngine(rawEngine);
  }
  if (typeof rawEngine !== "string" || !ENGINE_IDS.includes(rawEngine as EngineId)) {
    throw new ScheduleServiceError(400, {
      error: `engine must be one of: ${ENGINE_IDS.join(", ")}`,
    });
  }
  return rawEngine as EngineId;
}

function assertModelAllowed(engine: EngineId, model: string): void {
  if (!isModelAllowedForEngine(engine, model)) {
    throw new ScheduleServiceError(400, { error: "model_not_allowed", engine, model });
  }
}

function assertDispatchReady(engine: EngineId, model: string): void {
  assertModelAllowed(engine, model);
  if (!engineModelReadyForDispatch(engine, model)) {
    throw new ScheduleServiceError(403, { error: "engine_model_not_ready", engine, model });
  }
}

function assertAutomationIntegrationsReady(schedule: {
  delivery: AutomationJson | null;
  notifications: AutomationJson | null;
}): void {
  // Slack targets ({ slack: { channel } }) are executable through the durable
  // Slack outbox; anything else present can be drafted but not enabled.
  const error = automationSlackConfigError(schedule);
  if (error) {
    throw new ScheduleServiceError(403, {
      error: "automation_delivery_not_ready",
      detail: error,
    });
  }
}

export async function createScheduleForOrg(
  identity: { orgId: string; userId: string | null },
  body: Record<string, unknown>,
): Promise<ApiSchedule> {
  const name = textField(body, "name");
  if (!name) throw new ScheduleServiceError(400, { error: "name is required" });

  const cron = textField(body, "cron");
  if (!cron) throw new ScheduleServiceError(400, { error: "cron is required" });
  if (!isValidCron(cron)) {
    throw new ScheduleServiceError(400, { error: "cron must be a valid 5-field expression" });
  }

  const prompt = textField(body, "prompt");
  if (!prompt) throw new ScheduleServiceError(400, { error: "prompt is required" });

  const timezone = parseTimezone(body.timezone) ?? null;
  // Creation is an inert draft operation. Persist valid engine/model intent
  // even while a paid provider is temporarily unavailable; readiness is
  // enforced at enable and by the shared command lane at execution time.
  const engine = resolveDraftEngine(body.engine);
  const model = textField(body, "model") || defaultModelForEngine(engine);
  assertModelAllowed(engine, model);
  const skill = await parseSkillPin(identity.orgId, body.skill);
  const repos = (await parseRepos(body)) ?? [];
  const tags = stringArrayField(body, "tags") ?? [];
  const delivery = jsonObjectField(body, "delivery") ?? null;
  const notifications = jsonObjectField(body, "notifications") ?? null;
  const concurrency = jsonObjectField(body, "concurrency") ?? null;
  const queue = jsonObjectField(body, "queue") ?? null;
  const costLimits = jsonObjectField(body, "costLimits") ?? null;
  const frequencyLimits = jsonObjectField(body, "frequencyLimits") ?? null;
  const approvalPolicy = jsonObjectField(body, "approvalPolicy") ?? null;
  const enablementPolicy = jsonObjectField(body, "enablementPolicy") ?? null;

  const schedule = await createSchedule({
    orgId: identity.orgId,
    userId: identity.userId,
    name,
    cron,
    timezone,
    prompt,
    engine,
    model,
    skillId: skill?.skillId ?? null,
    skillVersion: skill?.skillVersion ?? null,
    skillContentHash: skill?.skillContentHash ?? null,
    repos,
    tags,
    delivery,
    notifications,
    runActorId: identity.userId,
    concurrency,
    queue,
    costLimits,
    frequencyLimits,
    approvalPolicy,
    enablementPolicy,
  });
  publishAutomationChange(identity.orgId, {
    type: "automation",
    action: "created",
    automationId: schedule.id,
  });
  await syncAutomationToContextIndex({
    id: schedule.id,
    orgId: schedule.org_id,
    name: schedule.name,
    prompt: schedule.prompt,
    cron: schedule.cron,
    tags: schedule.tags,
  });
  return schedule;
}

export async function updateScheduleForOrg(
  orgId: string,
  id: string,
  body: Record<string, unknown>,
): Promise<ApiSchedule> {
  const patch: Partial<{
    name: string;
    cron: string;
    timezone: string | null;
    prompt: string;
    engine: EngineId;
    model: string;
    skillId: string | null;
    skillVersion: number | null;
    skillContentHash: string | null;
    repos: string[];
    tags: string[];
    delivery: AutomationJson | null;
    notifications: AutomationJson | null;
    concurrency: AutomationJson | null;
    queue: AutomationJson | null;
    costLimits: AutomationJson | null;
    frequencyLimits: AutomationJson | null;
    approvalPolicy: AutomationJson | null;
    enablementPolicy: AutomationJson | null;
    enabled: boolean;
  }> = {};

  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;

  const timezone = parseTimezone(body.timezone);
  if (timezone !== undefined) patch.timezone = timezone;

  const name = textField(body, "name");
  if (name) patch.name = name;

  const prompt = textField(body, "prompt");
  if (prompt) patch.prompt = prompt;

  const model = textField(body, "model");
  if (model) patch.model = model;

  if (typeof body.cron === "string") {
    const cron = body.cron.trim();
    if (!isValidCron(cron)) {
      throw new ScheduleServiceError(400, { error: "cron must be a valid 5-field expression" });
    }
    patch.cron = cron;
  }

  if (body.engine !== undefined) patch.engine = resolveDraftEngine(body.engine);

  const skill = await parseSkillPin(orgId, body.skill);
  if (skill !== undefined) Object.assign(patch, skill);

  const repos = await parseRepos(body);
  if (repos !== undefined) patch.repos = repos;

  const tags = stringArrayField(body, "tags");
  if (tags !== undefined) patch.tags = tags;

  const delivery = jsonObjectField(body, "delivery");
  if (delivery !== undefined) patch.delivery = delivery;

  const notifications = jsonObjectField(body, "notifications");
  if (notifications !== undefined) patch.notifications = notifications;

  const concurrency = jsonObjectField(body, "concurrency");
  if (concurrency !== undefined) patch.concurrency = concurrency;

  const queue = jsonObjectField(body, "queue");
  if (queue !== undefined) patch.queue = queue;

  const costLimits = jsonObjectField(body, "costLimits");
  if (costLimits !== undefined) patch.costLimits = costLimits;

  const frequencyLimits = jsonObjectField(body, "frequencyLimits");
  if (frequencyLimits !== undefined) patch.frequencyLimits = frequencyLimits;

  const approvalPolicy = jsonObjectField(body, "approvalPolicy");
  if (approvalPolicy !== undefined) patch.approvalPolicy = approvalPolicy;

  const enablementPolicy = jsonObjectField(body, "enablementPolicy");
  if (enablementPolicy !== undefined) patch.enablementPolicy = enablementPolicy;

  if (
    patch.engine !== undefined ||
    patch.model !== undefined ||
    patch.skillId !== undefined ||
    patch.delivery !== undefined ||
    patch.notifications !== undefined ||
    patch.enabled === true
  ) {
    const current = await getScheduleForOrg(orgId, id);
    if (!current) throw new ScheduleServiceError(404, { error: "schedule not found" });
    const engine = patch.engine ?? current.engine;
    const model = patch.model ?? current.model;
    assertModelAllowed(engine, model);
    const remainsEnabled = patch.enabled ?? current.enabled;
    if (remainsEnabled) {
      assertDispatchReady(engine, model);
      assertAutomationIntegrationsReady({
        delivery: patch.delivery ?? current.delivery,
        notifications: patch.notifications ?? current.notifications,
      });
      const skillId = patch.skillId === undefined ? current.skillId : patch.skillId;
      const skillVersion = patch.skillVersion === undefined ? current.skillVersion : patch.skillVersion;
      const skillHash = patch.skillContentHash === undefined ? current.skillContentHash : patch.skillContentHash;
      if ((skillId && (!skillVersion || !skillHash)) || (!skillId && (skillVersion || skillHash))) {
        throw new ScheduleServiceError(400, { error: "invalid skill pin" });
      }
    }
  }

  const updated = await updateSchedule(orgId, id, patch);
  if (!updated) throw new ScheduleServiceError(404, { error: "schedule not found" });
  publishAutomationChange(orgId, {
    type: "automation",
    action: "updated",
    automationId: updated.id,
  });
  await syncAutomationToContextIndex({
    id: updated.id,
    orgId: updated.org_id,
    name: updated.name,
    prompt: updated.prompt,
    cron: updated.cron,
    tags: updated.tags,
  });
  return updated;
}

export async function deleteScheduleForOrg(orgId: string, id: string): Promise<void> {
  const deleted = await deleteSchedule(orgId, id);
  if (!deleted) throw new ScheduleServiceError(404, { error: "schedule not found" });
  publishAutomationChange(orgId, {
    type: "automation",
    action: "deleted",
    automationId: id,
  });
  await removeFromContextIndex(orgId, `automation:${id}`);
}

export async function fireScheduleForOrg(
  schedule: ScheduleRecord,
  trigger: ScheduleTrigger,
  occurrence: Date = new Date(),
): Promise<string> {
  // Keep service imports safe for the standalone gateway; the worker graph is
  // loaded only for an explicit fire mutation.
  const { fireScheduleWithOutcome } = await import("./fire");
  const { runId, firingRecorded } = await fireScheduleWithOutcome(
    schedule,
    trigger,
    occurrence,
  );
  if (firingRecorded) {
    publishAutomationChange(schedule.orgId, {
      type: "automation",
      action: "fired",
      automationId: schedule.id,
      runId,
    });
  }
  return runId;
}
