import { expect, test } from "bun:test";
import { db } from "../src/db/client";
import { spendAccounts } from "../src/db/schema";
import { executeAutomationToolLocal } from "../src/knowledge/gateway/automation-tools";
import {
  mintApprovalCapability,
  type ApprovalBinding,
  type ApprovalCapabilityStore,
} from "../src/knowledge/gateway/approval-capability";
import { defaultModelForEngine } from "../src/runs/model-policy";
import { createSchedule } from "../src/schedules/repo";
import "./helpers"; // boots src/index -> migrate

// An agent running an approved automation_run_now for a capped owner gets the
// structured allowance refusal (status 402, the figures), not a generic failure.

class MemoryApprovalStore implements ApprovalCapabilityStore {
  private readonly rows = new Map<string, ApprovalBinding>();
  async create(binding: ApprovalBinding): Promise<void> {
    this.rows.set(binding.nonce, binding);
  }
  async consume(binding: Omit<ApprovalBinding, "expiresAt">, now: Date): Promise<boolean> {
    const row = this.rows.get(binding.nonce);
    if (!row || row.expiresAt <= now || row.argumentsHash !== binding.argumentsHash) return false;
    this.rows.delete(binding.nonce);
    return true;
  }
}

test("automation_run_now for a capped owner returns the allowance refusal as a structured result", async () => {
  const orgId = `org-spend-${crypto.randomUUID()}`;
  const userId = `user-spend-${crypto.randomUUID()}`;
  const schedule = await createSchedule({
    orgId, userId, name: "nightly digest", cron: "0 0 * * *", timezone: "UTC", prompt: "summarise the day",
    engine: "mock", model: defaultModelForEngine("mock"), skillId: null, skillVersion: null,
    skillContentHash: null, repos: [], tags: [], delivery: null, notifications: null, runActorId: userId,
    concurrency: null, queue: null, costLimits: null, frequencyLimits: null, approvalPolicy: null,
    enablementPolicy: null,
  });
  await db.insert(spendAccounts).values({ orgId, userId, spentUsd: 50 });
  const claims = { orgId, userId, threadId: "thread-a", runId: "run-a", scope: "run" as const, exp: Date.now() + 60_000 };
  const store = new MemoryApprovalStore();
  const args = { id: schedule.id };
  const { capability } = await mintApprovalCapability(
    { ...claims, toolName: "automation_run_now", arguments: args },
    store,
  );
  const result = await executeAutomationToolLocal(
    claims,
    "automation_run_now",
    { ...args, approvalCapability: capability },
    { approvalStore: store },
  );
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    status: 402,
    error: { error: "spend_allowance_exceeded", spent: 50, allowance: 50 },
  });
  expect(result.content[0]?.text).toBe("spend_allowance_exceeded");
});
