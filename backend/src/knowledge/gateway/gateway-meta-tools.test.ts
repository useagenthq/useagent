import { describe, expect, test } from "bun:test";
import {
  executeGatewayMetaTool,
  GATEWAY_META_TOOLS,
} from "./gateway-meta-tools";
import type { GatewayToolDescriptor } from "./descriptor";
import { executeRegisteredGatewayTool } from "./operation-registry";
import type { ToolTokenClaims } from "./token";

const AVAILABLE_TOOLS = [
  {
    name: "knowledge_search",
    description: "Search the organization's knowledge base.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
] as const satisfies readonly GatewayToolDescriptor[];

const CLAIMS = {
  orgId: "org-test",
  userId: "user-test",
  threadId: "thread-test",
  runId: "run-test",
  scope: "run",
  exp: Date.now() + 60_000,
} as const satisfies ToolTokenClaims;

describe("gateway compact discovery", () => {
  test("advertises an invocation bridge alongside search and describe", () => {
    expect(GATEWAY_META_TOOLS.map((tool) => tool.name)).toEqual([
      "gateway_tools_search",
      "gateway_tool_describe",
      "gateway_tool_call",
    ]);
  });

  test("invokes an exact available tool without advertising every tool schema", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const result = await executeGatewayMetaTool(
      "gateway_tool_call",
      { name: "knowledge_search", arguments: { query: "release policy" } },
      AVAILABLE_TOOLS,
      async (name, args) => {
        calls.push({ name, args });
        return { content: [{ type: "text", text: "found" }] };
      },
    );

    expect(calls).toEqual([
      { name: "knowledge_search", args: { query: "release policy" } },
    ]);
    expect(result).toEqual({ content: [{ type: "text", text: "found" }] });
  });

  test("dispatches through the live registry with the original signed claims", async () => {
    const execution = await executeRegisteredGatewayTool(
      CLAIMS,
      "gateway_tool_call",
      { name: "automation_schema" },
      { childSessions: false, loopLogin: false, slack: false },
    );

    expect(execution.matched).toBe(true);
    if (!execution.matched) throw new Error("gateway_tool_call was not registered");
    const result = execution.result as {
      readonly structuredContent?: {
        readonly schema?: { readonly identity?: unknown };
      };
    };
    expect(result.structuredContent?.schema?.identity).toContain(
      "signed gateway capability",
    );
  });

  test("fails closed for unavailable and recursive targets", async () => {
    let calls = 0;
    const invoke = async () => {
      calls += 1;
      return { content: [{ type: "text", text: "unexpected" }] };
    };

    const unavailable = await executeGatewayMetaTool(
      "gateway_tool_call",
      { name: "memory_forget", arguments: { memoryRef: "other-org" } },
      AVAILABLE_TOOLS,
      invoke,
    );
    const recursive = await executeGatewayMetaTool(
      "gateway_tool_call",
      { name: "gateway_tools_search", arguments: { query: "memory" } },
      [...GATEWAY_META_TOOLS, ...AVAILABLE_TOOLS],
      invoke,
    );

    expect(calls).toBe(0);
    expect(unavailable).toMatchObject({ isError: true });
    expect(recursive).toMatchObject({ isError: true });
  });
});
