import { ENGINE_IDS, type EngineId } from "../db/schema";
import {
  engineModelReadyForDispatch,
  engineResolutionErrorBody,
  resolveAcceptedEngine,
} from "../runs/engine-readiness";
import { defaultModelForEngine, isModelAllowedForEngine } from "../runs/model-policy";
import { isValidCron, isValidTimezone } from "./cron";
import {
  createSchedule,
  deleteSchedule,
  getScheduleForOrg,
  updateSchedule,
  type ApiSchedule,
} from "./repo";

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

  return createSchedule({
    orgId: identity.orgId,
    userId: identity.userId,
    name,
    cron,
    timezone,
    prompt,
    engine,
    model,
  });
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

  if (
    patch.engine !== undefined ||
    patch.model !== undefined ||
    patch.enabled === true
  ) {
    const current = await getScheduleForOrg(orgId, id);
    if (!current) throw new ScheduleServiceError(404, { error: "schedule not found" });
    const engine = patch.engine ?? current.engine;
    const model = patch.model ?? current.model;
    assertModelAllowed(engine, model);
    const remainsEnabled = patch.enabled ?? current.enabled;
    if (remainsEnabled) assertDispatchReady(engine, model);
  }

  const updated = await updateSchedule(orgId, id, patch);
  if (!updated) throw new ScheduleServiceError(404, { error: "schedule not found" });
  return updated;
}

export async function deleteScheduleForOrg(orgId: string, id: string): Promise<void> {
  const deleted = await deleteSchedule(orgId, id);
  if (!deleted) throw new ScheduleServiceError(404, { error: "schedule not found" });
}
