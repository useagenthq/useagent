import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { executeChildSessionTool } from "./child-session-tools";
import { verifyToolToken, type ToolTokenClaims } from "./token";

// Gateway-mode delegation for child_session_* (mirrors the automation seam):
// the restricted gateway can never INSERT runs/run_commands/run_admissions, so
// in gateway mode every child-session op forwards to the loopback primary API
// under a short-lived re-minted capability, and fails CLOSED without an origin.

const originalFetch = globalThis.fetch;
const originalGatewayDb = process.env.GATEWAY_DATABASE_URL;
const originalApiOrigin = process.env.USEAGENT_API_ORIGIN;
const originalSecret = process.env.TOOL_GATEWAY_SECRET;

const claims: ToolTokenClaims = {
  orgId: "org-a",
  userId: "user-a",
  threadId: "thread-a",
  runId: "run-a",
  scope: "run",
  exp: Date.now() + 60_000,
};

beforeEach(() => {
  process.env.TOOL_GATEWAY_SECRET = "child-session-test-secret-0123456789abcdef";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalGatewayDb === undefined) delete process.env.GATEWAY_DATABASE_URL;
  else process.env.GATEWAY_DATABASE_URL = originalGatewayDb;
  if (originalApiOrigin === undefined) delete process.env.USEAGENT_API_ORIGIN;
  else process.env.USEAGENT_API_ORIGIN = originalApiOrigin;
  if (originalSecret === undefined) delete process.env.TOOL_GATEWAY_SECRET;
  else process.env.TOOL_GATEWAY_SECRET = originalSecret;
});

describe("child-session gateway control-plane delegation", () => {
  test("forwards through the primary API with a short-lived identity-bound capability", async () => {
    process.env.GATEWAY_DATABASE_URL = "postgres://restricted";
    process.env.USEAGENT_API_ORIGIN = "http://127.0.0.1:3201/path-is-ignored";
    const requests: Request[] = [];
    globalThis.fetch = (async (input, init) => {
      requests.push(input instanceof Request ? input : new Request(input.toString(), init));
      return Response.json({
        result: {
          content: [{ type: "text", text: "No child sessions exist for this thread." }],
          structuredContent: { children: [] },
        },
      });
    }) as typeof fetch;

    const result = await executeChildSessionTool(claims, "child_session_list", {});

    expect(result.isError).not.toBe(true);
    const request = requests[0];
    expect(request).toBeDefined();
    if (!request) throw new Error("expected a forwarded request");
    expect(request.url).toBe("http://127.0.0.1:3201/api/internal/child-sessions");
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
    expect(await request.json()).toEqual({ name: "child_session_list", arguments: {} });
  });

  test("fails closed when a restricted gateway has no primary API origin", async () => {
    process.env.GATEWAY_DATABASE_URL = "postgres://restricted";
    delete process.env.USEAGENT_API_ORIGIN;
    const result = await executeChildSessionTool(claims, "child_session_create", {
      prompt: "do a thing",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("not configured");
  });
});
