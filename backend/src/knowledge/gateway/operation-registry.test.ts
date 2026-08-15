import { describe, expect, test } from "bun:test";
import { CHILD_SESSION_TOOLS } from "./child-session-tools";
import { LOOP_LOGIN_TOOLS } from "./loop-login-tools";
import {
  advertisedGatewayToolDescriptors,
  baseGatewayToolDescriptors,
  executeRegisteredGatewayTool,
  gatewayCompactToolListEnabled,
  gatewayMetaToolDescriptors,
  gatewayToolListDescriptors,
  isGatewayMetaToolName,
} from "./operation-registry";
import { SLACK_TOOLS } from "./slack-tools";
import type { ToolTokenClaims } from "./token";

const ALL_OPTIONS = {
  childSessions: true,
  loopLogin: true,
  slack: true,
} as const;

const CLAIMS = {
  orgId: "org-test",
  userId: "user-test",
  threadId: "thread-test",
  runId: "run-test",
  scope: "run",
  exp: Date.now() + 60_000,
} as const satisfies ToolTokenClaims;

function structuredContent(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== "object" || !("structuredContent" in result)) {
    throw new Error(`Expected structuredContent in result: ${JSON.stringify(result)}`);
  }
  const content = (result as { structuredContent: unknown }).structuredContent;
  if (!content || typeof content !== "object") {
    throw new Error(`Expected structuredContent object in result: ${JSON.stringify(result)}`);
  }
  return content as Record<string, unknown>;
}

function resultTools(result: unknown): readonly unknown[] {
  const tools = structuredContent(result).tools;
  if (!Array.isArray(tools)) {
    throw new Error(`Expected structuredContent.tools array in result: ${JSON.stringify(result)}`);
  }
  return tools as readonly unknown[];
}

describe("gateway operation registry", () => {
  test("keeps the always-available catalog unique and well described", () => {
    const tools = baseGatewayToolDescriptors();
    const names = tools.map((tool) => tool.name);

    expect(new Set(names).size).toBe(names.length);
    expect(
      tools.every(
        (tool) =>
          tool.name.length > 0 &&
          tool.description.length > 0 &&
          typeof tool.inputSchema === "object",
      ),
    ).toBe(true);
  });

  test("advertises conditional capabilities only when their trusted context is present", () => {
    const baseNames = new Set(
      advertisedGatewayToolDescriptors({
        childSessions: false,
        loopLogin: false,
        slack: false,
      }).map((tool) => tool.name),
    );
    const enabledNames = new Set(
      advertisedGatewayToolDescriptors({
        childSessions: true,
        loopLogin: true,
        slack: true,
      }).map((tool) => tool.name),
    );

    for (const tool of LOOP_LOGIN_TOOLS) {
      expect(baseNames.has(tool.name)).toBe(false);
      expect(enabledNames.has(tool.name)).toBe(true);
    }
    for (const tool of SLACK_TOOLS) {
      expect(baseNames.has(tool.name)).toBe(false);
      expect(enabledNames.has(tool.name)).toBe(true);
    }
    for (const tool of CHILD_SESSION_TOOLS) {
      expect(baseNames.has(tool.name)).toBe(false);
      expect(enabledNames.has(tool.name)).toBe(true);
    }
  });

  test("keeps compact tool discovery opt-in", () => {
    expect(gatewayCompactToolListEnabled({ GATEWAY_COMPACT_TOOLS: undefined })).toBe(false);
    expect(gatewayCompactToolListEnabled({ GATEWAY_COMPACT_TOOLS: "0" })).toBe(false);
    expect(gatewayCompactToolListEnabled({ GATEWAY_COMPACT_TOOLS: "true" })).toBe(true);
    expect(gatewayCompactToolListEnabled({ GATEWAY_COMPACT_TOOLS: " yes " })).toBe(true);
  });

  test("compact catalog exposes only gateway search and describe tools", () => {
    const defaultNames = gatewayToolListDescriptors(ALL_OPTIONS, {}).map((tool) => tool.name);
    const compactNames = gatewayToolListDescriptors(ALL_OPTIONS, {
      GATEWAY_COMPACT_TOOLS: "1",
    }).map((tool) => tool.name);
    const metaNames = gatewayMetaToolDescriptors().map((tool) => tool.name);

    expect(defaultNames).toContain("knowledge_search");
    expect(defaultNames).toContain("automation_create");
    expect(defaultNames).not.toContain("gateway_tools_search");
    expect(compactNames).toEqual(metaNames);
    expect(compactNames.every(isGatewayMetaToolName)).toBe(true);
  });

  test("meta tools search and describe the live gateway catalog", async () => {
    const search = await executeRegisteredGatewayTool(
      CLAIMS,
      "gateway_tools_search",
      { query: "automation create" },
      ALL_OPTIONS,
    );
    expect(search.matched).toBe(true);
    if (!search.matched) throw new Error("gateway_tools_search was not registered");
    expect(resultTools(search.result)).toContainEqual(
      expect.objectContaining({ name: "automation_create" }),
    );

    const describe = await executeRegisteredGatewayTool(
      CLAIMS,
      "gateway_tool_describe",
      { name: "automation_create" },
      ALL_OPTIONS,
    );
    expect(describe.matched).toBe(true);
    if (!describe.matched) throw new Error("gateway_tool_describe was not registered");
    expect(structuredContent(describe.result).tool).toMatchObject({
      name: "automation_create",
      inputSchema: expect.objectContaining({
        type: "object",
        required: expect.arrayContaining(["name", "prompt", "cron"]),
      }),
    });
  });
});
