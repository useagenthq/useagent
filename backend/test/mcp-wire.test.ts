// #98 Option C: adopting the official @modelcontextprotocol/sdk schemas + error
// codes for protocol VALIDATION must NOT change the wire the opencode/ACP clients
// depend on. This pins the response BYTES for the deterministic protocol methods
// (the risk area is the error envelope + codes) - a before/after guarantee that
// the SDK swap is transparent. Tool execution is covered by knowledge-gateway.test.
import { describe, expect, test } from "bun:test";
import "../src/index";
import { handleMcpMessage } from "../src/knowledge/gateway/mcp";
import { advertisedGatewayToolDescriptors } from "../src/knowledge/gateway/operation-registry";
import type { ToolTokenClaims } from "../src/knowledge/gateway/token";

const CLAIMS: ToolTokenClaims = {
  orgId: "o",
  userId: "u",
  threadId: "t",
  runId: "r",
  scope: "run",
  exp: Date.now() + 60_000,
};
const req = (id: number, method: string, params?: Record<string, unknown>) =>
  ({ jsonrpc: "2.0" as const, id, method, ...(params ? { params } : {}) });

function resultRecord(response: Awaited<ReturnType<typeof handleMcpMessage>>): Record<string, unknown> {
  if (!response?.result || typeof response.result !== "object" || Array.isArray(response.result)) {
    throw new Error("expected a JSON-RPC object result");
  }
  return response.result as Record<string, unknown>;
}

describe("MCP wire is byte-identical after the SDK-schema adoption (#98)", () => {
  test("ping result envelope is byte-identical", async () => {
    const r = await handleMcpMessage(CLAIMS, req(7, "ping"));
    expect(JSON.stringify(r)).toBe('{"jsonrpc":"2.0","id":7,"result":{}}');
  });

  test("unknown method -> -32601 error envelope is byte-identical", async () => {
    const r = await handleMcpMessage(CLAIMS, req(8, "frobnicate"));
    expect(JSON.stringify(r)).toBe(
      '{"jsonrpc":"2.0","id":8,"error":{"code":-32601,"message":"Method not found: frobnicate"}}',
    );
  });

  test("unknown tool -> -32602 error envelope is byte-identical", async () => {
    const r = await handleMcpMessage(CLAIMS, req(9, "tools/call", { name: "nope", arguments: {} }));
    expect(JSON.stringify(r)).toBe(
      '{"jsonrpc":"2.0","id":9,"error":{"code":-32602,"message":"Unknown tool: nope"}}',
    );
  });

  test("initialize echoes the requested protocolVersion + static capabilities/serverInfo", async () => {
    const result = resultRecord(
      await handleMcpMessage(CLAIMS, req(1, "initialize", { protocolVersion: "2025-06-18" })),
    );
    expect(result.protocolVersion).toBe("2025-06-18");
    expect(result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(result.serverInfo).toEqual({ name: "skynet-knowledge", version: "1.0.0" });
  });

  test("tools/list returns the knowledge, execution, and semantic skill tool set", async () => {
    const result = resultRecord(await handleMcpMessage(CLAIMS, req(2, "tools/list")));
    expect(result.tools).toEqual(
      advertisedGatewayToolDescriptors({
        childSessions: false,
        loopLogin: false,
        slack: false,
      }),
    );
  });

  test("a notification-shaped method returns null (no response)", async () => {
    expect(await handleMcpMessage(CLAIMS, req(3, "notifications/initialized"))).toBeNull();
  });
});
