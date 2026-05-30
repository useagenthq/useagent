import type { ArtifactRecord } from "./repo";
import { publishOrgChange } from "../runs/org-signals";
import { mintToolToken, type ToolTokenClaims } from "../knowledge/gateway/token";

type ArtifactChangeAction = "proposed" | "updated";

function primaryApiOrigin(): string | null {
  if (!process.env.GATEWAY_DATABASE_URL) return null;
  const raw = process.env.SKYNET_API_ORIGIN?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function publishLocal(
  claims: ToolTokenClaims,
  artifact: Pick<ArtifactRecord, "id" | "runId" | "threadId">,
  action: ArtifactChangeAction,
): void {
  publishOrgChange(claims.orgId, {
    type: "artifact",
    action,
    artifactId: artifact.id,
    runId: artifact.runId,
    threadId: artifact.threadId,
  });
}

/**
 * Publish an artifact invalidation from either application process.
 *
 * Local development executes the tool and SSE route in one process, so the
 * existing in-memory org bus is sufficient. Production runs tools in the
 * restricted standalone gateway; there the invalidation is relayed to the
 * primary backend under the current short-lived run capability so the browser's
 * `/api/runs/changes` stream observes the committed revision.
 */
export async function publishArtifactChangeFromTool(
  claims: ToolTokenClaims,
  artifact: Pick<ArtifactRecord, "id" | "runId" | "threadId">,
  action: ArtifactChangeAction,
): Promise<void> {
  const origin = primaryApiOrigin();
  if (!process.env.GATEWAY_DATABASE_URL) {
    publishLocal(claims, artifact, action);
    return;
  }
  if (!origin) throw new Error("artifact change bridge is not configured");

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
  const response = await fetch(`${origin}/api/internal/artifact-changes`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ artifactId: artifact.id, action }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `artifact change bridge returned HTTP ${response.status}`);
  }
}
