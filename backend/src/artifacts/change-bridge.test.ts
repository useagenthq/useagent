import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { subscribeOrg } from "../runs/org-signals";
import { verifyToolToken, type ToolTokenClaims } from "../knowledge/gateway/token";
import { publishArtifactChangeFromTool } from "./change-bridge";

const originalFetch = globalThis.fetch;
const originalDatabaseUrl = process.env.GATEWAY_DATABASE_URL;
const originalApiOrigin = process.env.USEAGENT_API_ORIGIN;
const originalGatewaySecret = process.env.TOOL_GATEWAY_SECRET;

const claims: ToolTokenClaims = {
  orgId: "org-a",
  userId: "user-a",
  threadId: "thread-current",
  runId: "run-current",
  scope: "run",
  exp: Date.now() + 60_000,
};
const artifact = { id: "artifact-a", runId: "run-original", threadId: "thread-original" };

beforeEach(() => {
  delete process.env.GATEWAY_DATABASE_URL;
  delete process.env.USEAGENT_API_ORIGIN;
  process.env.TOOL_GATEWAY_SECRET = "artifact-change-test-secret-0123456789";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalDatabaseUrl === undefined) delete process.env.GATEWAY_DATABASE_URL;
  else process.env.GATEWAY_DATABASE_URL = originalDatabaseUrl;
  if (originalApiOrigin === undefined) delete process.env.USEAGENT_API_ORIGIN;
  else process.env.USEAGENT_API_ORIGIN = originalApiOrigin;
  if (originalGatewaySecret === undefined) delete process.env.TOOL_GATEWAY_SECRET;
  else process.env.TOOL_GATEWAY_SECRET = originalGatewaySecret;
});

describe("artifact change process bridge", () => {
  test("publishes directly when the tool and SSE stream share one process", async () => {
    const changes: unknown[] = [];
    const unsubscribe = subscribeOrg(claims.orgId, (change) => changes.push(change));
    try {
      await publishArtifactChangeFromTool(claims, artifact, "updated");
    } finally {
      unsubscribe();
    }
    expect(changes).toEqual([{
      type: "artifact",
      action: "updated",
      artifactId: artifact.id,
      runId: artifact.runId,
      threadId: artifact.threadId,
    }]);
  });

  test("relays standalone-gateway updates to the backend-owned SSE bus", async () => {
    process.env.GATEWAY_DATABASE_URL = "postgres://restricted";
    process.env.USEAGENT_API_ORIGIN = "http://127.0.0.1:3201/path-is-ignored";
    const requests: Request[] = [];
    globalThis.fetch = (async (input, init) => {
      requests.push(input instanceof Request ? input : new Request(input.toString(), init));
      return Response.json({ ok: true });
    }) as typeof fetch;

    await publishArtifactChangeFromTool(claims, artifact, "updated");

    const request = requests[0];
    expect(request?.url).toBe("http://127.0.0.1:3201/api/internal/artifact-changes");
    const authorization = request?.headers.get("authorization") ?? "";
    expect(verifyToolToken(authorization.replace(/^Bearer\s+/, ""))).toMatchObject({
      orgId: claims.orgId,
      userId: claims.userId,
      threadId: claims.threadId,
      runId: claims.runId,
      scope: claims.scope,
    });
    expect(await request?.json()).toEqual({ artifactId: artifact.id, action: "updated" });
  });
});
