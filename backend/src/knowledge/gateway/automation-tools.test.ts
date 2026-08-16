import { afterEach, describe, expect, test } from "bun:test";
import {
  AUTOMATION_TOOLS,
  executeAutomationTool,
  executeAutomationToolLocal,
} from "./automation-tools";
import {
  mintApprovalCapability,
  type ApprovalBinding,
  type ApprovalCapabilityStore,
} from "./approval-capability";
import { verifyToolToken, type ToolTokenClaims } from "./token";

const originalFetch = globalThis.fetch;
const originalGatewayDatabaseUrl = process.env.GATEWAY_DATABASE_URL;
const originalApiOrigin = process.env.SKYNET_API_ORIGIN;
const originalToolGatewaySecret = process.env.TOOL_GATEWAY_SECRET;

const claims: ToolTokenClaims = {
  orgId: "org-a",
  userId: "user-a",
  threadId: "thread-a",
  runId: "run-a",
  scope: "run",
  exp: Date.now() + 60_000,
};

class MemoryApprovalStore implements ApprovalCapabilityStore {
  private readonly rows = new Map<string, ApprovalBinding>();

  async create(binding: ApprovalBinding): Promise<void> {
    this.rows.set(binding.nonce, binding);
  }

  async consume(binding: ApprovalBinding, now: Date): Promise<boolean> {
    const row = this.rows.get(binding.nonce);
    if (!row || row.expiresAt <= now || JSON.stringify(row) !== JSON.stringify(binding)) {
      return false;
    }
    this.rows.delete(binding.nonce);
    return true;
  }
}

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
  test("advertises schema, list, create, and get as ordinary discoverable MCP tools", async () => {
    const names = AUTOMATION_TOOLS.map((tool) => tool.name);
    const createTool = AUTOMATION_TOOLS.find((tool) => tool.name === "automation_create");
    const getTool = AUTOMATION_TOOLS.find((tool) => tool.name === "automation_get");
    if (!createTool || !getTool) throw new Error("expected core Automation MCP tools");
    const createSchema = createTool.inputSchema as {
      required?: readonly string[];
      properties: Readonly<Record<string, unknown>>;
    };
    const getSchema = getTool.inputSchema as { required?: readonly string[] };

    expect(names).toEqual(
      expect.arrayContaining([
        "automation_schema",
        "automation_list",
        "automation_create",
        "automation_get",
      ]),
    );
    expect(createSchema.required).toEqual(["name", "cron", "prompt"]);
    expect(createSchema.properties.engine).not.toHaveProperty(
      "default",
    );
    expect(getSchema.required).toEqual(["id"]);

    const schema = await executeAutomationToolLocal(claims, "automation_schema", {});
    expect(schema.isError).not.toBe(true);
    const contract = schema.structuredContent?.schema as
      | { identity?: unknown; create?: unknown }
      | undefined;
    expect(contract?.identity).toContain("signed gateway capability");
    expect(contract?.create).toContain("always disabled");
    expect(
      (schema.structuredContent?.schema as { enable?: string } | undefined)?.enable,
    ).toContain("server-minted");
  });

  test("forwards through the primary API with a short-lived identity-bound capability", async () => {
    process.env.GATEWAY_DATABASE_URL = "postgres://restricted";
    process.env.SKYNET_API_ORIGIN = "http://127.0.0.1:3201/path-is-ignored";
    process.env.TOOL_GATEWAY_SECRET = "automation-test-secret-0123456789abcdef";
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

  test("model-authored booleans and predictable strings cannot approve a sensitive call", async () => {
    for (const approvalCapability of [undefined, "true", "approve", "automation_update:yes"]) {
      const result = await executeAutomationToolLocal(
        claims,
        "automation_update",
        { id: "automation-1", enabled: true, confirmEnable: true, approvalCapability },
        { approvalStore: new MemoryApprovalStore() },
      );
      expect(result.isError).toBe(true);
      expect(result.structuredContent?.error).toBe("approval_required");
    }
  });

  test("accepts an exact server-minted capability once before dispatch", async () => {
    const store = new MemoryApprovalStore();
    const args = { id: "", enabled: true };
    const { capability } = await mintApprovalCapability(
      { ...claims, toolName: "automation_update", arguments: args },
      store,
    );

    const first = await executeAutomationToolLocal(
      claims,
      "automation_update",
      { ...args, approvalCapability: capability },
      { approvalStore: store },
    );
    expect(first.content[0]?.text).toContain("requires an automation id");
    expect(first.structuredContent?.error).not.toBe("approval_required");

    const replay = await executeAutomationToolLocal(
      claims,
      "automation_update",
      { ...args, approvalCapability: capability },
      { approvalStore: store },
    );
    expect(replay.structuredContent?.error).toBe("approval_required");
  });
});
