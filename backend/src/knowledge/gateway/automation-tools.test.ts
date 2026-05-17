import { afterEach, describe, expect, test } from "bun:test";
import { executeAutomationTool } from "./automation-tools";
import { verifyToolToken, type ToolTokenClaims } from "./token";

const originalFetch = globalThis.fetch;
const originalGatewayDatabaseUrl = process.env.GATEWAY_DATABASE_URL;
const originalApiOrigin = process.env.SKYNET_API_ORIGIN;
const originalToolGatewaySecret = process.env.TOOL_GATEWAY_SECRET;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalGatewayDatabaseUrl === undefined) delete process.env.GATEWAY_DATABASE_URL;
  else process.env.GATEWAY_DATABASE_URL = originalGatewayDatabaseUrl;
  if (originalApiOrigin === undefined) delete process.env.SKYNET_API_ORIGIN;
  else process.env.SKYNET_API_ORIGIN = originalApiOrigin;
  if (originalToolGatewaySecret === undefined) delete process.env.TOOL_GATEWAY_SECRET;
  else process.env.TOOL_GATEWAY_SECRET = originalToolGatewaySecret;
});

describe("automation gateway control-plane delegation", () => {
  test("forwards through the primary API with a short-lived identity-bound capability", async () => {
    process.env.GATEWAY_DATABASE_URL = "postgres://restricted";
    process.env.SKYNET_API_ORIGIN = "http://127.0.0.1:3201/path-is-ignored";
    process.env.TOOL_GATEWAY_SECRET = "automation-test-secret-0123456789abcdef";
    const claims: ToolTokenClaims = {
      orgId: "org-a",
      userId: "user-a",
      threadId: "thread-a",
      runId: "run-a",
      scope: "run",
      exp: Date.now() + 60_000,
    };
    const requests: Request[] = [];
    globalThis.fetch = (async (input, init) => {
      requests.push(input instanceof Request ? input : new Request(input.toString(), init));
      return Response.json({
        result: {
          content: [{ type: "text", text: "No scheduled automations exist." }],
          structuredContent: { automations: [] },
        },
      });
    }) as typeof fetch;

    const result = await executeAutomationTool(claims, "automation_list", {});

    expect(result.isError).not.toBe(true);
    const request = requests[0];
    expect(request).toBeDefined();
    if (!request) throw new Error("expected a forwarded request");
    expect(request.url).toBe("http://127.0.0.1:3201/api/internal/automation");
    const authorization = request.headers.get("authorization") ?? "";
    const forwarded = verifyToolToken(authorization.replace(/^Bearer\s+/, ""));
    expect(forwarded).toMatchObject({
      orgId: "org-a",
      userId: "user-a",
      threadId: "thread-a",
      runId: "run-a",
      scope: "run",
    });
    expect((forwarded?.exp ?? 0) - Date.now()).toBeLessThanOrEqual(30_000);
    expect(await request.json()).toEqual({ name: "automation_list", arguments: {} });
  });

  test("fails closed when a restricted gateway has no primary API origin", async () => {
    process.env.GATEWAY_DATABASE_URL = "postgres://restricted";
    delete process.env.SKYNET_API_ORIGIN;
    const result = await executeAutomationTool(
      {
        orgId: "org-a",
        userId: "user-a",
        threadId: "thread-a",
        runId: "run-a",
        scope: "run",
        exp: Date.now() + 60_000,
      },
      "automation_list",
      {},
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("not configured");
  });
});
