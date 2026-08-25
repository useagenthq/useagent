import { errorResult } from "./tool-results";
import { mintToolToken, type ToolTokenClaims } from "./token";
import type { ToolCallResult } from "./tools";

export type GithubOperationFamily = "github" | "repository" | "context" | "resource";

type LocalGithubOperation = () => Promise<ToolCallResult>;

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
  family: GithubOperationFamily,
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
  const response = await fetch(`${origin}/api/internal/github-operations`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ family, name, arguments: args }),
    signal: AbortSignal.timeout(name === "github_pull_request_publish" ? 120_000 : 30_000),
  });
  const body = (await response.json().catch(() => null)) as
    | { result?: ToolCallResult; error?: string }
    | null;
  if (!response.ok || !body?.result) {
    return errorResult(body?.error ?? `GitHub control plane returned HTTP ${response.status}`, {
      status: response.status,
    });
  }
  return body.result;
}

/**
 * Execute a GitHub-credential-consuming gateway operation. Primary-backend and
 * unit-test callers use the unchanged local implementation. A restricted
 * gateway must delegate to the authenticated primary API and fails closed when
 * no primary origin is configured.
 */
export async function executeGithubBackedOperation(
  claims: ToolTokenClaims,
  family: GithubOperationFamily,
  name: string,
  args: Record<string, unknown>,
  executeLocal: LocalGithubOperation,
): Promise<ToolCallResult> {
  const origin = primaryApiOrigin();
  if (process.env.GATEWAY_DATABASE_URL && !origin) {
    return errorResult(
      "GitHub control plane is not configured; ask the workspace operator to set USEAGENT_API_ORIGIN for the gateway, then retry",
    );
  }
  if (!origin) return executeLocal();
  try {
    return await executeThroughPrimaryApi(origin, claims, family, name, args);
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : "GitHub control plane request failed");
  }
}
