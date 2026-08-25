import { Hono } from "hono";
import { executeContextToolLocal } from "./context-tools";
import { executeGithubToolLocal, GITHUB_TOOL_NAMES } from "./github-tools";
import type { GithubOperationFamily } from "./github-operation-bridge";
import {
  executeRepositoryToolLocal,
  REPOSITORY_TOOL_NAMES,
} from "./repository-tools";
import { executeResourceToolLocal } from "./resource-tools";
import { resolveToolRunIdentity } from "./run-authorization";
import { verifyToolToken, type ToolTokenClaims } from "./token";
import type { ToolCallResult } from "./tools";

const MAX_BODY_BYTES = 128 * 1024;

function bearer(header: string | undefined): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(header?.trim() ?? "");
  return match?.[1]?.trim() || null;
}

interface InternalGithubRouteDependencies {
  readonly resolveIdentity: (claims: ToolTokenClaims) => Promise<ToolTokenClaims | null>;
  readonly executeLocal: (
    family: GithubOperationFamily,
    claims: ToolTokenClaims,
    name: string,
    args: Record<string, unknown>,
  ) => Promise<ToolCallResult>;
}

const productionDependencies: InternalGithubRouteDependencies = {
  resolveIdentity: resolveToolRunIdentity,
  executeLocal: (family, claims, name, args) => {
    if (family === "github") return executeGithubToolLocal(claims, name, args);
    if (family === "repository") return executeRepositoryToolLocal(claims, name, args);
    if (family === "context") return executeContextToolLocal(claims, name, args);
    return executeResourceToolLocal(claims, name, args);
  },
};

function isAllowedOperation(
  family: string,
  name: string,
  args: Record<string, unknown>,
): family is GithubOperationFamily {
  if (family === "github") return GITHUB_TOOL_NAMES.has(name);
  if (family === "repository") return REPOSITORY_TOOL_NAMES.has(name);
  if (family === "context") {
    return name === "context_read" &&
      typeof args.source_ref === "string" &&
      args.source_ref.trim().startsWith("code:");
  }
  return family === "resource" &&
    name === "resource_catalog_search" &&
    typeof args.provider === "string" &&
    args.provider.trim().toLowerCase() === "github";
}

/**
 * Authenticated loopback bridge for the restricted tool-gateway process. The
 * signed capability supplies identity, then the primary database re-resolves
 * the currently live run before any backend-only GitHub credential is used.
 */
export function createInternalGithubRoutes(
  dependencies: InternalGithubRouteDependencies = productionDependencies,
): Hono {
  const routes = new Hono();
  routes.post("/", async (c) => {
    const claims = verifyToolToken(bearer(c.req.header("authorization")));
    if (!claims) return c.json({ error: "unauthorized" }, 401);
    const current = await dependencies.resolveIdentity(claims).catch(() => null);
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
    const args = record.arguments;
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return c.json({ error: "invalid_arguments" }, 400);
    }
    const family = typeof record.family === "string" ? record.family : "";
    const name = typeof record.name === "string" ? record.name : "";
    if (!isAllowedOperation(family, name, args as Record<string, unknown>)) {
      return c.json({ error: "unknown_github_operation" }, 400);
    }

    return c.json({
      result: await dependencies.executeLocal(
        family,
        current,
        name,
        args as Record<string, unknown>,
      ),
    });
  });
  return routes;
}

export const internalGithubRoutes = createInternalGithubRoutes();
