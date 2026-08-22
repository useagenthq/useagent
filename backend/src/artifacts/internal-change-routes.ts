import { Hono } from "hono";
import { getArtifactForOrg } from "./repo";
import { publishOrgChange } from "../runs/org-signals";
import { resolveToolRunIdentity } from "../knowledge/gateway/run-authorization";
import { verifyToolToken } from "../knowledge/gateway/token";

const MAX_BODY_BYTES = 4 * 1024;
const ACTIONS = new Set(["proposed", "updated"] as const);

function bearer(header: string | undefined): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(header?.trim() ?? "");
  return match?.[1]?.trim() || null;
}

/** Loopback bridge from the standalone tool gateway to the backend-owned SSE bus. */
export const internalArtifactChangeRoutes = new Hono();

internalArtifactChangeRoutes.post("/", async (c) => {
  const claims = verifyToolToken(bearer(c.req.header("authorization")));
  if (!claims) return c.json({ error: "unauthorized" }, 401);
  const current = await resolveToolRunIdentity(claims).catch(() => null);
  if (!current) return c.json({ error: "inactive_capability" }, 403);

  const contentLength = Number(c.req.header("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return c.json({ error: "request_too_large" }, 413);
  }
  let body: unknown;
  try {
    const raw = await c.req.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
      return c.json({ error: "request_too_large" }, 413);
    }
    body = JSON.parse(raw);
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "invalid_request" }, 400);
  }
  const record = body as Record<string, unknown>;
  const artifactId = typeof record.artifactId === "string" ? record.artifactId.trim() : "";
  const action = record.action;
  if (!artifactId || typeof action !== "string" || !ACTIONS.has(action as "proposed" | "updated")) {
    return c.json({ error: "invalid_request" }, 400);
  }

  const artifact = await getArtifactForOrg(current.orgId, artifactId);
  if (!artifact) return c.json({ error: "artifact_not_found" }, 404);
  if (artifact.threadId !== current.threadId) {
    return c.json({ error: "artifact_not_found" }, 404);
  }
  publishOrgChange(current.orgId, {
    type: "artifact",
    action: action as "proposed" | "updated",
    artifactId: artifact.id,
    runId: artifact.runId,
    threadId: artifact.threadId,
  });
  return c.json({ ok: true });
});
