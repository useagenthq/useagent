import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../http";
import {
  createGatewayApprovalRoutes,
  internalGatewayApprovalRoutes,
  issueGatewayOperationApproval,
} from "./approval-routes";

const activeRun = {
  id: "run-a",
  userId: "user-a",
  threadId: "thread-a",
  status: "running" as string,
} as const;

function dependencies(run = activeRun) {
  return {
    findRun: async (orgId: string, runId: string) =>
      orgId === "org-a" && runId === run.id ? run : null,
    requiresApproval: (name: string) => name === "automation_delete",
    mint: async (input: {
      orgId: string;
      userId: string;
      threadId: string;
      runId: string;
      toolName: string;
      arguments: Readonly<Record<string, unknown>>;
    }) => ({
      capability: `signed:${JSON.stringify(input)}`,
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      argumentsHash: "hash-a",
    }),
  };
}

describe("gateway approval mint route", () => {
  test("derives org, user, and thread from authenticated server state", async () => {
    const result = await issueGatewayOperationApproval(
      { orgId: "org-a", userId: "user-a" },
      {
        runId: "run-a",
        toolName: "automation_delete",
        arguments: { id: "automation-1" },
      },
      dependencies(),
    );
    expect(result).toMatchObject({
      tool_name: "automation_delete",
      arguments_hash: "hash-a",
    });
    expect(result.capability).toContain('"orgId":"org-a"');
    expect(result.capability).toContain('"userId":"user-a"');
    expect(result.capability).toContain('"threadId":"thread-a"');
  });

  test("rejects another user, inactive runs, unregistered tools, and nested capabilities", async () => {
    await expect(
      issueGatewayOperationApproval(
        { orgId: "org-a", userId: "user-b" },
        { runId: "run-a", toolName: "automation_delete", arguments: { id: "a" } },
        dependencies(),
      ),
    ).rejects.toMatchObject({ code: "run_user_mismatch", status: 403 });
    await expect(
      issueGatewayOperationApproval(
        { orgId: "org-a", userId: "user-a" },
        { runId: "run-a", toolName: "automation_delete", arguments: { id: "a" } },
        dependencies({ ...activeRun, status: "completed" }),
      ),
    ).rejects.toMatchObject({ code: "run_not_active", status: 409 });
    await expect(
      issueGatewayOperationApproval(
        { orgId: "org-a", userId: "user-a" },
        { runId: "run-a", toolName: "anything_delete", arguments: { id: "a" } },
        dependencies(),
      ),
    ).rejects.toMatchObject({ code: "tool_does_not_accept_approval", status: 400 });
    await expect(
      issueGatewayOperationApproval(
        { orgId: "org-a", userId: "user-a" },
        {
          runId: "run-a",
          toolName: "automation_delete",
          arguments: { id: "a", approvalCapability: "model-value" },
        },
        dependencies(),
      ),
    ).rejects.toMatchObject({ code: "approval_capability_must_be_omitted", status: 400 });
  });

  test("route uses the request identity already resolved by org auth", async () => {
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("orgId", "org-a");
      c.set("userId", "user-a");
      return next();
    });
    app.route("/", createGatewayApprovalRoutes(dependencies()));
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runId: "run-a",
        toolName: "automation_delete",
        arguments: { id: "automation-1" },
      }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ tool_name: "automation_delete" });
  });

  test("internal consumption bridge fails closed without its signed run capability", async () => {
    const response = await internalGatewayApprovalRoutes.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        toolName: "knowledge_draft_publish",
        arguments: { documentId: "doc-a", approvalCapability: "model-value" },
      }),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });
});
