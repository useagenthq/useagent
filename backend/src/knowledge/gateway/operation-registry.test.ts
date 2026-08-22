import { describe, expect, test } from "bun:test";
import { CHILD_SESSION_TOOLS } from "./child-session-tools";
import { LOOP_LOGIN_TOOLS } from "./loop-login-tools";
import {
  advertisedGatewayToolDescriptor,
  advertisedGatewayToolDescriptors,
  baseGatewayToolDescriptors,
  executeRegisteredGatewayTool,
  GATEWAY_APPROVAL_REQUIRED_TOOL_NAMES,
  gatewayCompactToolListEnabled,
  gatewayMetaToolDescriptors,
  gatewayToolListDescriptors,
  gatewayToolRequiresApproval,
  isRegisteredGatewayToolName,
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

  test("keeps names unique across always-on and conditional families", () => {
    const names = advertisedGatewayToolDescriptors(ALL_OPTIONS).map((tool) => tool.name);

    expect(new Set(names).size).toBe(names.length);
  });

  test("exposes exact registered names without granting prefix lookalikes", () => {
    expect(isRegisteredGatewayToolName("gcs_list_buckets")).toBe(true);
    expect(isRegisteredGatewayToolName("gateway_tools_search")).toBe(true);
    expect(isRegisteredGatewayToolName("gcs_delete_bucket")).toBe(false);
    expect(isRegisteredGatewayToolName("computer_future")).toBe(false);
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
    expect(defaultNames).toContain("context_search");
    expect(defaultNames).toContain("context_read");
    expect(defaultNames).toContain("automation_create");
    expect(defaultNames).toContain("workpiece_create");
    expect(defaultNames).not.toContain("gateway_tools_search");
    expect(compactNames).toEqual(metaNames);
    expect(compactNames.every(isGatewayMetaToolName)).toBe(true);
  });

  test("pins the unified context index tools as always-on base tools", () => {
    const baseNames = baseGatewayToolDescriptors().map((tool) => tool.name);
    // The context family is a BASE family (advertised without any conditional
    // context), mirroring knowledge_search/skills_list. These two names are a
    // deliberate release surface - adding/removing one updates this pin.
    expect(baseNames).toContain("context_search");
    expect(baseNames).toContain("context_read");
    // Neither is approval-gated: unified search + read are read-only.
    expect(gatewayToolRequiresApproval("context_search")).toBe(false);
    expect(gatewayToolRequiresApproval("context_read")).toBe(false);
  });

  test("preserves semantic discovery while marking exact sensitive operations", () => {
    const descriptors = advertisedGatewayToolDescriptors(ALL_OPTIONS);
    const update = descriptors.find((tool) => tool.name === "automation_update");
    const list = descriptors.find((tool) => tool.name === "automation_list");
    const publish = descriptors.find((tool) => tool.name === "knowledge_draft_publish");
    const integrationExecute = descriptors.find(
      (tool) => tool.name === "integration_action_execute",
    );
    if (!update || !list || !publish || !integrationExecute) {
      throw new Error("expected sensitive descriptors");
    }
    const updateSchema = update.inputSchema as {
      readonly properties?: Readonly<Record<string, unknown>>;
      readonly required?: readonly string[];
    };
    const listSchema = list.inputSchema as {
      readonly properties?: Readonly<Record<string, unknown>>;
      readonly required?: readonly string[];
    };
    const publishSchema = publish.inputSchema as {
      readonly properties?: Readonly<Record<string, unknown>>;
      readonly required?: readonly string[];
    };
    const integrationSchema = integrationExecute.inputSchema as {
      readonly properties?: Readonly<Record<string, unknown>>;
      readonly required?: readonly string[];
    };

    expect(gatewayToolRequiresApproval("automation_update")).toBe(true);
    expect(gatewayToolRequiresApproval("automation_run_now")).toBe(true);
    expect(gatewayToolRequiresApproval("automation_delete")).toBe(true);
    expect(gatewayToolRequiresApproval("knowledge_draft_publish")).toBe(true);
    expect(gatewayToolRequiresApproval("knowledge_draft_archive")).toBe(true);
    expect(gatewayToolRequiresApproval("automation_list")).toBe(false);
    expect(gatewayToolRequiresApproval("made_up_delete_task")).toBe(false);
    expect(updateSchema.required).toContain("approvalCapability");
    expect(updateSchema.properties).toHaveProperty("approvalCapability");
    expect(updateSchema.properties).not.toHaveProperty("confirmEnable");
    expect(listSchema.properties).not.toHaveProperty("approvalCapability");
    expect(publishSchema.required).toContain("approvalCapability");
    expect(publishSchema.properties).not.toHaveProperty("confirmPublish");
    expect(publishSchema.properties).not.toHaveProperty("confirmationToken");
    expect(integrationSchema.required).toContain("approvalCapability");
    expect(integrationSchema.properties).toHaveProperty("approvalCapability");
  });

  test("pins the approval-gated operation set and the mid-run approval lane", () => {
    // The registry is the single source of which tools need approval. This set
    // is a deliberate release decision - extending it (e.g. GitHub write tools)
    // must update this pin consciously.
    expect([...GATEWAY_APPROVAL_REQUIRED_TOOL_NAMES].toSorted()).toEqual([
      "automation_delete",
      "automation_run_now",
      "automation_update",
      "integration_action_execute",
      "knowledge_draft_archive",
      "knowledge_draft_publish",
    ]);

    // The approval lane itself is advertised and never approval-gated:
    // requesting or polling an approval must not require one.
    const names = advertisedGatewayToolDescriptors(ALL_OPTIONS).map((tool) => tool.name);
    expect(names).toContain("approval_request");
    expect(names).toContain("approval_poll");
    expect(gatewayToolRequiresApproval("approval_request")).toBe(false);
    expect(gatewayToolRequiresApproval("approval_poll")).toBe(false);

    // approval_request validates gated-argument completeness against the exact
    // registered descriptor.
    expect(advertisedGatewayToolDescriptor("automation_delete")?.name).toBe(
      "automation_delete",
    );
    expect(advertisedGatewayToolDescriptor("made_up_tool")).toBeNull();
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
    const tool = structuredContent(describe.result).tool;
    if (!tool || typeof tool !== "object") {
      throw new Error(`Expected described tool object: ${JSON.stringify(describe.result)}`);
    }
    const descriptor = tool as {
      readonly name?: unknown;
      readonly inputSchema?: { readonly type?: unknown; readonly required?: unknown };
    };
    expect(descriptor.name).toBe("automation_create");
    expect(descriptor.inputSchema?.type).toBe("object");
    expect(descriptor.inputSchema?.required).toEqual(["name", "cron", "prompt"]);
  });
});
