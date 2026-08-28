import { Hono } from "hono";
import type { AppEnv } from "../http";
import { RunAdmissionClosedError } from "../commands";
import { FleetQueueLimitError } from "./intake";
import {
  FleetBatchIdempotencyConflictError,
} from "./batch-repo";
import {
  fleetBatchReadEnabled,
  fleetBatchWriteEnabled,
} from "./batch-rollout";
import {
  acceptFleetBatch,
  fleetBatchResponse,
  preflightFleetBatchReplay,
  readFleetBatchForContext,
  resolveFleetBatchTasks,
  validateFleetBatchBody,
} from "./batch-service";
import { pumpThread } from "../worker";

export const fleetBatchRoutes = new Hono<AppEnv>();

fleetBatchRoutes.post("/", async (c) => {
  if (!fleetBatchReadEnabled()) return c.json({ error: "not_found" }, 404);
  if (!fleetBatchWriteEnabled()) return c.json({ error: "fleet_batch_write_disabled" }, 403);

  const idempotencyKey = c.req.header("Idempotency-Key")?.trim() ?? "";
  if (!idempotencyKey) return c.json({ error: "idempotency_key_required" }, 400);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const validated = validateFleetBatchBody(body);
  if (!validated.ok) return c.json(validated.body, validated.status);

  const actorId = c.get("userId");
  if (!actorId) return c.json({ error: "authenticated_user_required" }, 401);

  const common = {
    orgId: c.get("orgId"),
    actorId,
    idempotencyKey,
    requestFingerprint: validated.fingerprint,
    itemCount: validated.tasks.length,
  };
  try {
    const replay = await preflightFleetBatchReplay(common);
    if (replay) return c.json(fleetBatchResponse(replay, true), 200);

    const resolved = await resolveFleetBatchTasks(common.orgId, validated.tasks);
    if (!resolved.ok) return c.json(resolved.body, resolved.status);

    const accepted = await acceptFleetBatch({
      ...common,
      tasks: resolved.tasks,
    });
    if (!accepted.created) return c.json(fleetBatchResponse(accepted.batch, true), 200);

    await Promise.allSettled(accepted.batch.runs.map((run) => pumpThread(run.runId)));
    const refreshed = await readFleetBatchForContext(c, accepted.batch.id);
    return c.json(fleetBatchResponse(refreshed ?? accepted.batch, false), 201);
  } catch (error) {
    if (error instanceof FleetBatchIdempotencyConflictError) {
      return c.json({ error: "idempotency_key_reused" }, 409);
    }
    if (error instanceof FleetQueueLimitError) {
      return c.json({ error: error.code, retryable: true, limit: error.limit }, 429);
    }
    if (error instanceof RunAdmissionClosedError) {
      return c.json({ error: error.code, retryable: true }, 503);
    }
    if (error instanceof Error && error.message === "fleet_batch_idempotency_key_invalid") {
      return c.json({ error: "idempotency_key_invalid" }, 400);
    }
    throw error;
  }
});

fleetBatchRoutes.get("/:id", async (c) => {
  if (!fleetBatchReadEnabled()) return c.json({ error: "not_found" }, 404);
  const id = c.req.param("id");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    return c.json({ error: "fleet_batch_not_found" }, 404);
  }
  const batch = await readFleetBatchForContext(c, id);
  if (!batch) return c.json({ error: "fleet_batch_not_found" }, 404);
  return c.json(fleetBatchResponse(batch, false));
});
