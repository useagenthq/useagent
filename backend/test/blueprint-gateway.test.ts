import { beforeAll, describe, expect, test } from "bun:test";
import { db } from "../src/db/client";
import { runs } from "../src/db/schema";
import { createGatewayApp } from "../src/gateway-app";
import { mintToolToken } from "../src/knowledge/gateway/token";
import { createSkillWithRevision } from "../src/skills/repo";
import { uid } from "./helpers";

const MCP = "/api/mcp/knowledge";
const gateway = createGatewayApp();

function call(id: number, name: string, args: Record<string, unknown>) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

async function rpc(token: string, message: unknown): Promise<any> {
  const response = await gateway.request(MCP, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(message),
  });
  expect(response.status).toBe(200);
  return response.json();
}

describe("blueprint gateway lifecycle", () => {
  const orgId = uid("blueprint-org");
  const foreignOrgId = uid("blueprint-foreign");
  const runId = uid("blueprint-run");
  let blueprintId = "";
  let foreignBlueprintId = "";
  let token = "";

  beforeAll(async () => {
    await db.insert(runs).values({
      id: runId,
      orgId,
      userId: "blueprint-user",
      prompt: "prepare repository",
      model: "gpt-5.5",
      engine: "codex",
      status: "running",
      threadId: runId,
    });
    const blueprint = await createSkillWithRevision({
      orgId,
      kind: "playbook",
      name: "Blueprint: upstream-org/backend",
      description: "Versioned environment setup reference.",
      tags: ["blueprint", "sample-export"],
      sections: {
        overview: ["Run setup only inside the task sandbox."],
        procedure: [
          "Confirm the target repository matches this blueprint.",
          "```yaml",
          "initialize: |",
          "  bun install --frozen-lockfile",
          "```",
        ],
        verify: ["The repository and blueprint names match."],
      },
    });
    blueprintId = blueprint!.id;
    token = mintToolToken({ orgId, userId: "blueprint-user", threadId: runId, runId }, 60_000);

    const foreignBlueprint = await createSkillWithRevision({
      orgId: foreignOrgId,
      kind: "playbook",
      name: "Blueprint: Secret/foreign",
      description: "Foreign blueprint.",
      tags: ["blueprint"],
      sections: { overview: ["sandbox only"], procedure: ["```yaml", "initialize: echo no", "```"], verify: ["done"] },
    });
    foreignBlueprintId = foreignBlueprint!.id;
  });

  test("lists, reads, validates, and plans without executing", async () => {
    const listed = await rpc(token, call(1, "blueprint_list", {}));
    expect(listed.result.structuredContent.blueprints).toHaveLength(1);
    expect(listed.result.structuredContent.blueprints[0].id).toBe(blueprintId);

    const read = await rpc(token, call(2, "blueprint_get", { blueprintId }));
    expect(read.result.structuredContent.blueprint.yaml).toContain("bun install --frozen-lockfile");

    const validated = await rpc(token, call(3, "blueprint_validate", {
      blueprintId,
      repository: "upstream-org/backend",
    }));
    expect(validated.result.isError).toBeUndefined();
    expect(validated.result.structuredContent.valid).toBe(true);

    const planned = await rpc(token, call(4, "blueprint_apply_plan", {
      blueprintId,
      repository: "upstream-org/backend",
    }));
    expect(planned.result.structuredContent.plan).toMatchObject({
      repository: "upstream-org/backend",
      sandboxOnly: true,
      executed: false,
      blueprint: {
        id: blueprintId,
        version: 1,
        contentRef: `blueprint:${blueprintId}@1`,
      },
    });

    const oversized = await createSkillWithRevision({
      orgId,
      kind: "playbook",
      name: "Blueprint: upstream-org/large",
      description: "Large reference content must not flood the model context.",
      tags: ["blueprint"],
      sections: {
        overview: ["Run setup only inside the task sandbox."],
        procedure: ["```yaml", `initialize: ${"x".repeat(12_000)}`, "```"],
        verify: ["v".repeat(12_000)],
      },
    });
    const oversizedRead = await rpc(token, call(5, "blueprint_get", {
      blueprintId: oversized!.id,
    }));
    expect(oversizedRead.result.structuredContent.blueprint.yaml).toHaveLength(8_000);
    expect(oversizedRead.result.structuredContent.blueprint.truncated).toBe(true);
    expect(oversizedRead.result.structuredContent.blueprint.sections).toBeUndefined();

    const oversizedPlan = await rpc(token, call(6, "blueprint_apply_plan", {
      blueprintId: oversized!.id,
      repository: "upstream-org/large",
    }));
    expect(JSON.stringify(oversizedPlan.result.structuredContent.plan).length).toBeLessThan(17_000);
    expect(oversizedPlan.result.structuredContent.plan.truncated).toBe(true);
  });

  test("fails closed for cross-org ids and repository mismatches", async () => {
    const foreignList = await rpc(token, call(7, "blueprint_list", { limit: 25 }));
    expect(foreignList.result.structuredContent.blueprints).toHaveLength(2);

    const mismatch = await rpc(token, call(8, "blueprint_validate", {
      blueprintId,
      repository: "Other/backend",
    }));
    expect(mismatch.result.isError).toBe(true);
    expect(mismatch.result.structuredContent.errors[0]).toContain("not Other/backend");

    const missing = await rpc(token, call(9, "blueprint_get", {
      blueprintId: foreignBlueprintId,
    }));
    expect(missing.result.isError).toBe(true);
    expect(missing.result.structuredContent.status).toBe(404);

    const malformed = await rpc(token, call(10, "blueprint_get", { blueprintId: "not-a-uuid" }));
    expect(malformed.result.isError).toBe(true);
    expect(malformed.result.structuredContent.status).toBe(404);
  });
});
