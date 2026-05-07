// #98 Option C: adopting the official @modelcontextprotocol/sdk schemas + error
// codes for protocol VALIDATION must NOT change the wire the opencode/ACP clients
// depend on. This pins the response BYTES for the deterministic protocol methods
// (the risk area is the error envelope + codes) - a before/after guarantee that
// the SDK swap is transparent. Tool execution is covered by knowledge-gateway.test.
import { describe, expect, test } from "bun:test";
import { handleMcpMessage } from "../src/knowledge/gateway/mcp";
import { KNOWLEDGE_TOOLS } from "../src/knowledge/gateway/tools";
import { MEMORY_TOOLS } from "../src/knowledge/gateway/memory-tools";
import type { ToolTokenClaims } from "../src/knowledge/gateway/token";

const CLAIMS: ToolTokenClaims = { orgId: "o", userId: "u", threadId: "t", runId: "r", exp: Date.now() + 60_000 };
const req = (id: number, method: string, params?: Record<string, unknown>) =>
  ({ jsonrpc: "2.0" as const, id, method, ...(params ? { params } : {}) });

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
    const r = (await handleMcpMessage(CLAIMS, req(1, "initialize", { protocolVersion: "2025-06-18" }))) as any;
    expect(r.result.protocolVersion).toBe("2025-06-18");
    expect(r.result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(r.result.serverInfo).toEqual({ name: "skynet-knowledge", version: "1.0.0" });
  });

  test("tools/list returns exactly the knowledge + memory tool set", async () => {
    const r = (await handleMcpMessage(CLAIMS, req(2, "tools/list"))) as any;
    expect(r.result.tools).toEqual([...KNOWLEDGE_TOOLS, ...MEMORY_TOOLS]);
  });

  test("a notification-shaped method returns null (no response)", async () => {
    expect(await handleMcpMessage(CLAIMS, req(3, "notifications/initialized"))).toBeNull();
  });
});
