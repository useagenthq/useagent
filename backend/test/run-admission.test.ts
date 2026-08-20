import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  getRunAdmission,
  RunAdmissionClosedError,
  setRunAdmission,
} from "../src/commands/admission";
import { acceptRunCommand } from "../src/commands";
import { createChildSession } from "../src/runs/child-sessions";
import { createOrgSession, json, uid } from "./helpers";

const OPERATION = `test-admission:${crypto.randomUUID()}`;

afterEach(async () => {
  await setRunAdmission({
    open: true,
    operationId: OPERATION,
    actor: "test",
    reason: "test cleanup",
  });
});

async function closeAdmission(): Promise<void> {
  await setRunAdmission({
    open: false,
    operationId: OPERATION,
    actor: "test",
    reason: "deployment test",
  });
}

describe("durable run admission", () => {
  test("blocks new acceptance while preserving an already accepted keyed replay", async () => {
    const orgId = `org-${uid("admission")}`;
    const runId = crypto.randomUUID();
    const idempotencyKey = uid("accepted-before-close");
    const input = {
      idempotencyKey,
      orgId,
      actorId: null,
      run: {
        id: runId,
        prompt: "accepted before deploy",
        model: "claude-opus-5",
        engine: "mock" as const,
        parentRunId: null,
        threadId: runId,
        repos: [],
        memoryScope: "org" as const,
        skillId: null,
        skillVersion: null,
        skillContentHash: null,
        commandName: null,
        commandProvider: null,
        commandSessionId: null,
        commandCatalogRevision: null,
      },
    };
    expect(await acceptRunCommand(input)).toMatchObject({ status: "created", runId });
    await closeAdmission();

    expect(await acceptRunCommand(input)).toEqual({ status: "replayed", runId });
    await expect(acceptRunCommand({
      ...input,
      idempotencyKey: uid("new-while-closed"),
      run: { ...input.run, id: crypto.randomUUID(), threadId: crypto.randomUUID() },
    })).rejects.toBeInstanceOf(RunAdmissionClosedError);
    expect(await getRunAdmission()).toMatchObject({
      open: false,
      operationId: OPERATION,
      actor: "test",
    });
  });

  test("HTTP, skill, schedule, and child-session ingress refuse new work while closed", async () => {
    const session = await createOrgSession("admission-ingress");
    const skill = await json<{ id: string }>("/api/skills", {
      method: "POST",
      body: { name: `Admission ${uid("skill")}` },
      cookies: session.cookies,
    });
    const schedule = await json<{ id: string }>("/api/schedules", {
      method: "POST",
      body: {
        name: "Admission schedule",
        cron: "0 4 * * *",
        prompt: "scheduled",
        engine: "mock",
      },
      cookies: session.cookies,
    });
    const parentId = crypto.randomUUID();
    await acceptRunCommand({
      idempotencyKey: null,
      orgId: session.orgId,
      actorId: null,
      run: {
        id: parentId,
        prompt: "parent",
        model: "claude-opus-5",
        engine: "mock",
        parentRunId: null,
        threadId: parentId,
        repos: [],
        memoryScope: "org",
        skillId: null,
        skillVersion: null,
        skillContentHash: null,
        commandName: null,
        commandProvider: null,
        commandSessionId: null,
        commandCatalogRevision: null,
      },
    });
    await closeAdmission();

    expect((await json("/api/runs", {
      method: "POST",
      body: { prompt: "blocked", engine: "mock" },
      cookies: session.cookies,
    })).status).toBe(503);
    expect((await json(`/api/skills/${skill.body.id}/run`, {
      method: "POST",
      body: { prompt: "blocked", engine: "mock" },
      cookies: session.cookies,
    })).status).toBe(503);
    expect((await json(`/api/schedules/${schedule.body.id}/run-now`, {
      method: "POST",
      cookies: session.cookies,
    })).status).toBe(503);
    await expect(createChildSession({
      orgId: session.orgId,
      actorId: null,
      parentRunId: parentId,
      threadId: parentId,
      prompt: "blocked child",
      engine: "mock",
      model: "claude-opus-5",
      repos: [],
      memoryScope: "org",
      idempotencyKey: uid("blocked-child"),
    })).rejects.toBeInstanceOf(RunAdmissionClosedError);
  });

  test("every run-producing ingress reaches the shared preflight before source mutation", async () => {
    const files = await Promise.all([
      "../src/runs/routes.ts",
      "../src/slack/events.ts",
      "../src/schedules/fire.ts",
      "../src/skills/routes.ts",
      "../src/runs/child-sessions.ts",
    ].map((path) => readFile(new URL(path, import.meta.url), "utf8")));
    for (const source of files) {
      const gate = source.indexOf("preflightRunCommandReplay(");
      expect(gate).toBeGreaterThan(-1);
      for (const mutation of ["resolveRunIntake(", "stageInboundSlackFiles("]) {
        const index = source.indexOf(mutation);
        if (index >= 0) expect(gate).toBeLessThan(index);
      }
    }
  });
});
