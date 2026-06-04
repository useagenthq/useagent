import { Hono } from "hono";
import {
  CHILD_SESSION_TOOL_NAMES,
  executeChildSessionToolLocal,
} from "./child-session-tools";
import { resolveToolRunIdentity } from "./run-authorization";
import { verifyToolToken } from "./token";

const MAX_BODY_BYTES = 128 * 1024;

function bearer(header: string | undefined): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(header?.trim() ?? "");
  return match?.[1]?.trim() || null;
}

/**
 * Loopback control-plane bridge used only by the restricted tool-gateway
 * process (mirrors /api/internal/automation). Child-session creation INSERTs
 * runs/run_commands/run_admissions, which the restricted gateway role can
 * never do - so the gateway forwards the call here under the same short-lived
 * run capability MCP uses, and this process re-resolves the currently live run
 * before executing. No organization or user identity is accepted from the body.
 */
export const internalChildSessionRoutes = new Hono();

internalChildSessionRoutes.post("/", async (c) => {
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
  const name = typeof record.name === "string" ? record.name : "";
  if (!CHILD_SESSION_TOOL_NAMES.has(name)) {
    return c.json({ error: "unknown_child_session_tool" }, 400);
  }
  const args = record.arguments;
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return c.json({ error: "invalid_arguments" }, 400);
  }

  return c.json({
    result: await executeChildSessionToolLocal(
      current,
      name,
      args as Record<string, unknown>,
    ),
  });
});
