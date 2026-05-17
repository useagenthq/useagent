import type { EngineId } from "../db/schema";
import {
  engineResolutionErrorBody,
  modelProviderReadyForEngine,
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

function resolveEngine(rawEngine: unknown): EngineId {
  const resolved = resolveAcceptedEngine(rawEngine);
  if (!resolved.ok) {
    throw new ScheduleServiceError(resolved.status, engineResolutionErrorBody(resolved));
  }
  return resolved.engine;
}

function assertModelReady(engine: EngineId, model: string): void {
  if (!isModelAllowedForEngine(engine, model)) {
    throw new ScheduleServiceError(400, { error: "model_not_allowed", engine, model });
  }
  if (!modelProviderReadyForEngine(engine, model)) {
    throw new ScheduleServiceError(403, { error: "model_provider_not_ready", engine, model });
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
  const engine = resolveEngine(body.engine);
  const model = textField(body, "model") || defaultModelForEngine(engine);
  assertModelReady(engine, model);

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

  if (body.engine !== undefined) patch.engine = resolveEngine(body.engine);

  if (patch.engine !== undefined || patch.model !== undefined) {
    const current = await getScheduleForOrg(orgId, id);
    if (!current) throw new ScheduleServiceError(404, { error: "schedule not found" });
    assertModelReady(patch.engine ?? current.engine, patch.model ?? current.model);
  }

  const updated = await updateSchedule(orgId, id, patch);
  if (!updated) throw new ScheduleServiceError(404, { error: "schedule not found" });
  return updated;
}

export async function deleteScheduleForOrg(orgId: string, id: string): Promise<void> {
  const deleted = await deleteSchedule(orgId, id);
  if (!deleted) throw new ScheduleServiceError(404, { error: "schedule not found" });
}
