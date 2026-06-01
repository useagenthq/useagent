import { afterEach, describe, expect, test } from "bun:test";
import type { IntegrationActionCatalogEntry } from "@useagent/agent-client/integrations";
import {
  executeIntegrationTool,
  setIntegrationToolServiceForTest,
} from "./integration-tools";
import type { ToolTokenClaims } from "./token";

const CLAIMS = {
  orgId: "org-a",
  userId: "user-a",
  threadId: "thread-a",
  runId: "run-a",
  scope: "run",
  exp: Date.now() + 60_000,
} as const satisfies ToolTokenClaims;

function entry(overrides: Partial<IntegrationActionCatalogEntry> = {}): IntegrationActionCatalogEntry {
  return {
    catalogVersion: 1,
    runtimeVersion: "1.4.0",
    runtimeCommit: "96fb6afe8c244c7d6f3a8351df06d7b04137f6a6",
    provider: "linear",
    actionId: "linear.get_issue",
    publicName: "get_issue",
    description: "Read one Linear issue.",
    inputSchema: {
      type: "object",
      properties: { issueId: { type: "string" } },
      required: ["issueId"],
      additionalProperties: false,
    },
    effect: "read",
    approval: "none",
    timeoutMs: 8_000,
    maxResultBytes: 8_000,
    idempotent: true,
    ...overrides,
  };
}

afterEach(() => setIntegrationToolServiceForTest(null));

describe("integration gateway tools", () => {
  test("search returns only tenant-visible connected action metadata", async () => {
    const calls: unknown[] = [];
    setIntegrationToolServiceForTest({
      async list(scope) {
        calls.push(scope);
        return [
          { connectionId: "connection-a", entry: entry() },
          {
            connectionId: "connection-b",
            entry: entry({
              provider: "gmail",
              actionId: "gmail.send_email",
              publicName: "send_email",
              description: "Send a Gmail message.",
            }),
          },
        ];
      },
      async execute() {
        throw new Error("not used");
      },
    });

    const result = await executeIntegrationTool(CLAIMS, "integration_actions_search", {
      query: "linear issue",
    });

    expect(calls).toEqual([{ orgId: "org-a", userId: "user-a" }]);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent?.actions).toEqual([
      expect.objectContaining({
        connectionId: "connection-a",
        provider: "linear",
        actionId: "linear.get_issue",
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain("runtimeBindingId");
    expect(JSON.stringify(result)).not.toContain("externalConnectionId");
  });

  test("execute rechecks the exact visible connection and action", async () => {
    const calls: unknown[] = [];
    setIntegrationToolServiceForTest({
      async list() {
        return [{ connectionId: "connection-a", entry: entry() }];
      },
      async execute(input) {
        calls.push(input);
        return { issue: { id: "LIN-1" } };
      },
    });

    const result = await executeIntegrationTool(CLAIMS, "integration_action_execute", {
      connectionId: "connection-a",
      actionId: "linear.get_issue",
      input: { issueId: "LIN-1" },
      idempotencyKey: "read-LIN-1",
    });

    expect(result.isError).not.toBe(true);
    expect(calls).toEqual([
      {
        orgId: "org-a",
        userId: "user-a",
        connectionId: "connection-a",
        actionId: "linear.get_issue",
        input: { issueId: "LIN-1" },
        idempotencyKey: "read-LIN-1",
        approvalGranted: true,
      },
    ]);
  });

  test("execute refuses an action that disappeared before the call", async () => {
    let executeCalls = 0;
    setIntegrationToolServiceForTest({
      async list() {
        return [];
      },
      async execute() {
        executeCalls += 1;
        return {};
      },
    });

    const result = await executeIntegrationTool(CLAIMS, "integration_action_execute", {
      connectionId: "connection-a",
      actionId: "linear.get_issue",
      input: { issueId: "LIN-1" },
    });

    expect(executeCalls).toBe(0);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("not available");
  });

  test("execute does not return an oversized connector response", async () => {
    setIntegrationToolServiceForTest({
      async list() {
        return [{
          connectionId: "connection-a",
          entry: entry({ maxResultBytes: 16 }),
        }];
      },
      async execute() {
        return { content: "x".repeat(100) };
      },
    });

    const result = await executeIntegrationTool(CLAIMS, "integration_action_execute", {
      connectionId: "connection-a",
      actionId: "linear.get_issue",
      input: { issueId: "LIN-1" },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("exceeded 16 bytes");
    expect(JSON.stringify(result)).not.toContain("xxxxxxxx");
  });
});
