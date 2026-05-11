import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "../index"; // side-effect: run committed migrations before DB assertions
import { db } from "../db/client";
import { providerGatewayAudit, runs } from "../db/schema";
import {
  beginProviderGatewayAudit,
  finishProviderGatewayAudit,
  ProviderGatewayAdmissionError,
} from "./audit";

const runIds: string[] = [];

afterEach(async () => {
  for (const runId of runIds.splice(0)) {
    await db.delete(providerGatewayAudit).where(eq(providerGatewayAudit.runId, runId));
    await db.delete(runs).where(eq(runs.id, runId));
  }
});

describe("provider gateway durable audit", () => {
  test("stores metadata only and settles the receipt", async () => {
    const runId = `run-${crypto.randomUUID()}`;
    const id = `audit-${crypto.randomUUID()}`;
    runIds.push(runId);
    await db.insert(runs).values({
      id: runId,
      orgId: "org-a",
      userId: "user-a",
      prompt: "secret prompt must never enter the audit row",
      model: "gpt-5",
      engine: "codex",
      status: "running",
      threadId: runId,
    });

    await beginProviderGatewayAudit(
      {
        id,
        runId,
        orgId: "org-a",
        provider: "openai",
        path: "/v1/responses",
        model: "gpt-5",
        requestedOutputTokens: 25,
      },
      {
        maxRequestsPerRun: 2,
        maxConcurrentPerRun: 1,
        maxOutputTokens: 100,
        maxOutputTokensPerRun: 1_000,
        upstreamTimeoutMs: 1_000,
      },
    );
    await finishProviderGatewayAudit({
      id,
      outcome: "responded",
      upstreamStatus: 200,
      durationMs: 42,
    });

    const [row] = await db
      .select()
      .from(providerGatewayAudit)
      .where(eq(providerGatewayAudit.id, id));
    expect(row).toMatchObject({
      runId,
      orgId: "org-a",
      provider: "openai",
      path: "/v1/responses",
      model: "gpt-5",
      requestedOutputTokens: 25,
      outcome: "responded",
      upstreamStatus: 200,
      durationMs: 42,
    });
    expect(Object.keys(row ?? {})).not.toContain("body");
    expect(Object.keys(row ?? {})).not.toContain("headers");
  });

  test("serializes admission across request and concurrency budgets", async () => {
    const runId = `run-${crypto.randomUUID()}`;
    runIds.push(runId);
    await db.insert(runs).values({
      id: runId,
      orgId: "org-a",
      userId: "user-a",
      prompt: "bounded",
      model: "gpt-5",
      engine: "codex",
      status: "running",
      threadId: runId,
    });
    const limits = {
      maxRequestsPerRun: 2,
      maxConcurrentPerRun: 1,
      maxOutputTokens: 100,
      maxOutputTokensPerRun: 1_000,
      upstreamTimeoutMs: 60_000,
    };
    const start = (id: string) =>
      beginProviderGatewayAudit(
        {
          id,
          runId,
          orgId: "org-a",
          provider: "openai",
          path: "/v1/responses",
          model: "gpt-5",
          requestedOutputTokens: 25,
        },
        limits,
      );

    const first = `audit-${crypto.randomUUID()}`;
    await start(first);
    await expect(start(`audit-${crypto.randomUUID()}`)).rejects.toEqual(
      new ProviderGatewayAdmissionError("concurrency_exhausted"),
    );
    await finishProviderGatewayAudit({ id: first, outcome: "responded", durationMs: 1 });
    const second = `audit-${crypto.randomUUID()}`;
    await start(second);
    await finishProviderGatewayAudit({ id: second, outcome: "responded", durationMs: 1 });
    await expect(start(`audit-${crypto.randomUUID()}`)).rejects.toEqual(
      new ProviderGatewayAdmissionError("request_budget_exhausted"),
    );
  });

  test("reserves a cumulative output-token budget per run", async () => {
    const runId = `run-${crypto.randomUUID()}`;
    runIds.push(runId);
    await db.insert(runs).values({
      id: runId,
      orgId: "org-a",
      userId: "user-a",
      prompt: "bounded output",
      model: "gpt-5",
      engine: "codex",
      status: "running",
      threadId: runId,
    });
    const limits = {
      maxRequestsPerRun: 10,
      maxConcurrentPerRun: 10,
      maxOutputTokens: 100,
      maxOutputTokensPerRun: 100,
      upstreamTimeoutMs: 60_000,
    };
    const start = (requestedOutputTokens: number) =>
      beginProviderGatewayAudit(
        {
          id: `audit-${crypto.randomUUID()}`,
          runId,
          orgId: "org-a",
          provider: "openai",
          path: "/v1/responses",
          model: "gpt-5",
          requestedOutputTokens,
        },
        limits,
      );
    await start(60);
    await expect(start(41)).rejects.toEqual(
      new ProviderGatewayAdmissionError("output_budget_exhausted"),
    );
    await start(40);
  });
});
