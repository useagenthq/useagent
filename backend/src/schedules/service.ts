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
  USER_FACING_ENGINES,
} from "../runs/engine-readiness";
import { defaultModelForEngine, isModelAllowedForEngine } from "../runs/model-policy";
import { modelOfferedToUser } from "../provider-gateway/provider-accounts";
import { publishOrgChange, type OrgChange } from "../runs/org-signals";
import { automationSlackConfigError } from "../slack/automation";
import {
  resolveExecutableSkillPin,
  SkillPinIntegrityError,
  type SkillPinReference,
} from "../skills/pins";
import { resolveSkillSelection } from "../skills/repo";
import { RunIntakeError } from "../resources/run-intake";
import { RunAdmissionClosedError } from "../commands";
import { SpendAllowanceExceededError } from "../runs/spend";
import { SandboxMinutesExceededError } from "../runs/sandbox-minutes";
import { BotsDisabledError } from "../bots/rollout";
import { RoutineOwnerError } from "../bots/owner";
import { asOrgAdmin } from "../provider-connections/repo";
import { memberDisplayNames } from "../team/member-names";
import {
  assertRunPromptLimit,
  RunPromptTooLargeError,
} from "../commands/prompt-policy";
import { isValidCron, isValidTimezone, nextOccurrence } from "./cron";
import {
  createSchedule,
  deleteSchedule,
  getScheduleForOrg,
  nextRunAt,
  updateSchedule,
  type ApiSchedule,
  type ScheduleRecord,
} from "./repo";

type AutomationChange = Extract<OrgChange, { readonly type: "automation" }>;

/**
 * Who may act on an automation, a bot's routines included. Every firing runs as
 * its creator: their keys, allowance, sandbox minutes and personal connections,
 * where reads need no approval. So only the creator changes what it does,
 * switches it on or runs it now. An org owner or admin may also pause or delete
 * it, which runs nothing as anyone; that is authorized in the organisation's
 * turn, as role changes are (org-lock.ts), so an admin demoted meanwhile gets
 * nothing done. One with no creator runs as nobody, so any member may act on
 * it. The service asks it around the change itself (update, delete, run now),
 * so every door gets it: the automations API, the bot page and an agent's
 * automation tools, where the agent acts as its run's owner.
 */
async function asAutomationActor<T>(
  orgId: string,
  scheduleId: string,
  actorId: string | null,
  intent: "change" | "stop",
  act: () => Promise<T>,
): Promise<T> {
  const schedule = await getScheduleForOrg(orgId, scheduleId);
  if (!schedule) throw new ScheduleServiceError(404, { error: "schedule not found" });
  const creator = schedule.userId;
  if (creator === null || creator === actorId) return act();
  if (intent === "stop" && actorId !== null) {
    const stopped = await asOrgAdmin(orgId, actorId, act);
    if (stopped) return stopped.value;
  }
  const name = (await memberDisplayNames(orgId, [creator])).get(creator) ?? "the person who created it";
  throw new ScheduleServiceError(403, {
    error: "automation_creator_only",
    message: `This automation runs as ${name}, so only they can change it or run it now. An admin can pause or delete it.`,
  });
}

/** A change that only pauses: the one an admin may make to someone else's automation. */
function pausesOnly(body: Record<string, unknown>): boolean {
  return body.enabled === false && Object.keys(body).every((key) => key === "enabled");
}

function publishAutomationChange(orgId: string, change: AutomationChange): void {
  publishOrgChange(orgId, change);
}

export class ScheduleServiceError extends Error {
  readonly status: 400 | 402 | 403 | 404 | 409 | 413 | 503;
  readonly body: Record<string, unknown>;

  constructor(status: 400 | 402 | 403 | 404 | 409 | 413 | 503, body: Record<string, unknown>) {
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

async function parseRepos(
  orgId: string,
  body: Record<string, unknown>,
): Promise<string[] | undefined> {
  const repos = stringArrayField(body, "repos");
  if (repos === undefined) return undefined;
  if (repos.length > 0) {
    const unknown = await unknownRepos(repos, orgId);
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

/** The zone a request names, validated; none for absent, null or "". */
function parseTimezone(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
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
      error: `engine must be one of: ${USER_FACING_ENGINES.join(", ")}`,
    });
  }
  return rawEngine as EngineId;
}

function assertModelAllowed(engine: EngineId, model: string): void {
  if (!isModelAllowedForEngine(engine, model)) {
    throw new ScheduleServiceError(400, { error: "model_not_allowed", engine, model });
  }
}

/** A provider PROVIDER_ACCOUNTS withholds from the schedule's owner is no model for it, the same answer as above. */
async function assertModelOffered(engine: EngineId, model: string, userId: string | null): Promise<void> {
  if (!(await modelOfferedToUser(engine, model, userId))) {
    throw new ScheduleServiceError(400, { error: "model_not_allowed", engine, model });
  }
}

function assertDispatchReady(engine: EngineId, model: string): void {
  assertModelAllowed(engine, model);
  if (!engineModelReadyForDispatch(engine, model)) {
    throw new ScheduleServiceError(403, { error: "engine_model_not_ready", engine, model });
  }
}

function assertSchedulePromptLimit(prompt: string): void {
  try {
    assertRunPromptLimit(prompt);
  } catch (error) {
    if (error instanceof RunPromptTooLargeError) {
      throw new ScheduleServiceError(413, { error: error.code });
    }
    throw error;
  }
}

async function assertAutomationIntegrationsReady(schedule: {
  delivery: AutomationJson | null;
  notifications: AutomationJson | null;
}, orgId: string): Promise<void> {
  // Tenant-qualified Slack targets are executable through the durable
  // Slack outbox; anything else present can be drafted but not enabled.
  const error = await automationSlackConfigError(schedule, orgId);
  if (error) {
    throw new ScheduleServiceError(403, {
      error: "automation_delivery_not_ready",
      detail: error,
    });
  }
}

async function assertAutomationSkillPinExecutable(pin: SkillPinReference): Promise<void> {
  try {
    await resolveExecutableSkillPin(pin, { requireContentHash: true });
  } catch (error) {
    if (error instanceof SkillPinIntegrityError) {
      throw new ScheduleServiceError(error.code === "invalid_skill_pin" ? 400 : 409, {
        error: error.code,
        detail: error.message,
      });
    }
    throw error;
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
  assertSchedulePromptLimit(prompt);

  // Every schedule names the zone its cron runs in. A create that sends none
  // (an API client, an agent's tool call) runs in UTC; the web app sends its
  // creator's browser zone.
  const timezone = parseTimezone(body.timezone) ?? "UTC";
  // Creation is an inert draft operation. Persist valid engine/model intent
  // even while a paid provider is temporarily unavailable; readiness is
  // enforced at enable and by the shared command lane at execution time.
  const engine = resolveDraftEngine(body.engine);
  const model = textField(body, "model") || defaultModelForEngine(engine);
  assertModelAllowed(engine, model);
  await assertModelOffered(engine, model, identity.userId);
  const skill = await parseSkillPin(identity.orgId, body.skill);
  const repos = (await parseRepos(identity.orgId, body)) ?? [];
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

/** How many runs a schedule preview names. */
const PREVIEW_RUNS = 3;
/** Longer than any cron a person types (every minute listed is 170 characters):
 *  the preview refuses more before parsing, as it answers while typing. */
const PREVIEW_CRON_MAX_LENGTH = 512;

/**
 * The next runs a schedule with this cron and zone would have if enabled now,
 * by the rule the scheduler fires by (repo.ts nextRunAt, then cron.ts
 * nextOccurrence): what an editor shows while a person types a schedule,
 * before anything is saved. The first is this minute when it is an
 * occurrence, as the tick would still fire it. The zone defaults to UTC as a
 * create's does; fewer runs (none) when the cron names fewer dates.
 */
export function previewNextRuns(query: { cron?: unknown; timezone?: unknown }, now: Date = new Date()): string[] {
  const cron = typeof query.cron === "string" ? query.cron.trim() : "";
  if (cron.length > PREVIEW_CRON_MAX_LENGTH || !isValidCron(cron)) {
    throw new ScheduleServiceError(400, { error: "cron must be a valid 5-field expression" });
  }
  const timezone = parseTimezone(query.timezone) ?? "UTC";
  const runs: string[] = [];
  let next = nextRunAt({ cron, timezone, enabled: true, lastFiredAt: null }, now);
  while (next && runs.length < PREVIEW_RUNS) {
    runs.push(next.toISOString());
    if (runs.length < PREVIEW_RUNS) next = nextOccurrence(cron, timezone, new Date(next.getTime() + 60_000));
  }
  return runs;
}

export function updateScheduleForOrg(
  orgId: string,
  id: string,
  body: Record<string, unknown>,
  actorId: string | null,
): Promise<ApiSchedule> {
  return asAutomationActor(orgId, id, actorId, pausesOnly(body) ? "stop" : "change", () => updateSchedulePatch(orgId, id, body));
}

async function updateSchedulePatch(
  orgId: string,
  id: string,
  body: Record<string, unknown>,
): Promise<ApiSchedule> {
  const patch: Partial<{
    name: string;
    cron: string;
    timezone: string;
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

  // A patch may move the schedule to another zone. One that names none (a
  // client still holding the schedule from before every schedule named one
  // sends null) leaves the zone as it is.
  const timezone = parseTimezone(body.timezone);
  if (timezone !== undefined) patch.timezone = timezone;

  const name = textField(body, "name");
  if (name) patch.name = name;

  const prompt = textField(body, "prompt");
  if (prompt) {
    assertSchedulePromptLimit(prompt);
    patch.prompt = prompt;
  }

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

  const repos = await parseRepos(orgId, body);
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
    await assertModelOffered(engine, model, current.userId);
    const remainsEnabled = patch.enabled ?? current.enabled;
    if (remainsEnabled) {
      assertDispatchReady(engine, model);
      await assertAutomationIntegrationsReady({
        delivery: patch.delivery ?? current.delivery,
        notifications: patch.notifications ?? current.notifications,
      }, orgId);
      const skillId = patch.skillId === undefined ? current.skillId : patch.skillId;
      const skillVersion = patch.skillVersion === undefined ? current.skillVersion : patch.skillVersion;
      const skillHash = patch.skillContentHash === undefined ? current.skillContentHash : patch.skillContentHash;
      if ((skillId && (!skillVersion || !skillHash)) || (!skillId && (skillVersion || skillHash))) {
        throw new ScheduleServiceError(400, { error: "invalid skill pin" });
      }
      await assertAutomationSkillPinExecutable({
        skillId,
        skillVersion,
        skillContentHash: skillHash,
      });
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

export function deleteScheduleForOrg(orgId: string, id: string, actorId: string | null): Promise<void> {
  return asAutomationActor(orgId, id, actorId, "stop", async () => {
    const deleted = await deleteSchedule(orgId, id);
    if (!deleted) throw new ScheduleServiceError(404, { error: "schedule not found" });
    publishAutomationChange(orgId, {
      type: "automation",
      action: "deleted",
      automationId: id,
    });
    await removeFromContextIndex(orgId, `automation:${id}`);
  });
}

/** Run now: a manual firing, which runs as the creator like every firing. */
export function runScheduleNow(schedule: ScheduleRecord, actorId: string | null): Promise<string> {
  return asAutomationActor(schedule.orgId, schedule.id, actorId, "change", () => fireSchedule(schedule, "manual"));
}

/** The scheduler's firing of a due occurrence. A person's firing is runScheduleNow. */
export function fireScheduleForOrg(
  schedule: ScheduleRecord,
  trigger: Extract<ScheduleTrigger, "cron">,
  occurrence: Date = new Date(),
): Promise<string> {
  return fireSchedule(schedule, trigger, occurrence);
}

async function fireSchedule(
  schedule: ScheduleRecord,
  trigger: ScheduleTrigger,
  occurrence: Date = new Date(),
): Promise<string> {
  // Keep service imports safe for the standalone gateway; the worker graph is
  // loaded only for an explicit fire mutation.
  const { fireScheduleWithOutcome } = await import("./fire");
  let fired: Awaited<ReturnType<typeof fireScheduleWithOutcome>>;
  try {
    fired = await fireScheduleWithOutcome(schedule, trigger, occurrence);
  } catch (error) {
    if (error instanceof BotsDisabledError) {
      throw new ScheduleServiceError(409, { error: error.code, retryable: false });
    }
    if (error instanceof RoutineOwnerError) throw new ScheduleServiceError(403, { error: error.code, message: error.message });
    if (error instanceof SkillPinIntegrityError) {
      throw new ScheduleServiceError(error.code === "invalid_skill_pin" ? 400 : 409, {
        error: error.code,
        detail: error.message,
      });
    }
    if (error instanceof RunIntakeError) {
      throw new ScheduleServiceError(
        error.code === "resource_unauthorized" ? 403 : 400,
        { error: error.code, ...error.diagnostic },
      );
    }
    if (error instanceof RunAdmissionClosedError) {
      throw new ScheduleServiceError(503, error.body);
    }
    if (error instanceof SpendAllowanceExceededError) throw new ScheduleServiceError(402, error.body);
    if (error instanceof SandboxMinutesExceededError) throw new ScheduleServiceError(402, error.body);
    throw error;
  }
  const { runId, firingRecorded } = fired;
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
