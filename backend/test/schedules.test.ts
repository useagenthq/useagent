import { describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import type { ApiRun } from "../src/runs/repo";
import { subscribeOrg, type OrgChange } from "../src/runs/org-signals";
import type { ApiFiring, ApiSchedule } from "../src/schedules/repo";
import { tick } from "../src/schedules/scheduler";
import { acceptRunCommand, type RunCommandIntent } from "../src/commands";
import { fireScheduleWithOutcome, firingKey } from "../src/schedules/fire";
import { getScheduleForOrg, nextRunAt } from "../src/schedules/repo";
import { AUTOMATION_RUN_ORIGIN } from "../src/runs/origin";
import { previewNextRuns } from "../src/schedules/service";
import { db } from "../src/db/client";
import { runs, skillRevisions } from "../src/db/schema";
import { createOrgSession, json, waitFor } from "./helpers";
import {
  freeModelLaneCache,
} from "../src/runs/free-model-lane";
import { RUN_PROMPT_MAX_CHARS } from "../src/commands/prompt-policy";

interface AutomationListResponse {
  readonly automations: ApiSchedule[];
  readonly schedules: ApiSchedule[];
}

interface FiringHistoryResponse {
  readonly firings: ApiFiring[];
}

interface RunNowResponse {
  readonly run_id: string;
}

interface EngineModelNotReadyResponse {
  readonly error: "engine_model_not_ready";
  readonly engine: ApiSchedule["engine"];
  readonly model: string;
}

interface ApiSkill {
  readonly id: string;
  readonly current_version: number;
}

/** Create a schedule under the given org session; returns the created body. */
async function createSchedule(
  cookies: string,
  body: Record<string, unknown>,
): Promise<ApiSchedule> {
  const res = await json<ApiSchedule>("/api/schedules", {
    method: "POST",
    body,
    cookies,
  });
  expect(res.status).toBe(201);
  return res.body;
}

async function createSkill(cookies: string): Promise<ApiSkill> {
  const res = await json<ApiSkill>("/api/skills", {
    method: "POST",
    cookies,
    body: {
      name: `Automation skill ${crypto.randomUUID()}`,
      description: "Pinned automation procedure.",
      tags: [],
      sections: { overview: ["ov"], procedure: ["proc"], verify: ["ver"] },
    },
  });
  expect(res.status).toBe(201);
  return res.body;
}

describe("schedules API", () => {
  test("the preview names the next three runs a cron and zone would have, with plain errors for what it cannot read", async () => {
    const s = await createOrgSession("sched-preview");
    const preview = (route: string, query: Record<string, string>) =>
      json<{ next_runs?: string[]; error?: string }>(`${route}/preview?${new URLSearchParams(query)}`, { cookies: s.cookies });
    const before = Date.now();
    const weekdays = await preview("/api/automations", { cron: "0 9 * * 1-5", timezone: "Asia/Kolkata" });
    expect(weekdays.status).toBe(200);
    const runs = weekdays.body.next_runs ?? [];
    expect(runs).toHaveLength(3);
    const kolkata = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    for (const run of runs) expect(kolkata.format(new Date(run))).toMatch(/^(Mon|Tue|Wed|Thu|Fri) 09:00$/);
    expect(Date.parse(runs[0]!)).toBeGreaterThanOrEqual(before - 60_000);
    expect(new Set(runs).size).toBe(3);
    expect(runs.toSorted()).toEqual(runs);
    // The alias answers the same; no zone means UTC, as a create without one.
    const utc = await preview("/api/schedules", { cron: "30 6 * * *" });
    expect(utc.status).toBe(200);
    for (const run of utc.body.next_runs ?? []) expect(run.slice(11, 16)).toBe("06:30");
    // A cron that names no date has no runs.
    const never = await preview("/api/automations", { cron: "0 0 31 2 *", timezone: "UTC" });
    expect(never.status).toBe(200);
    expect(never.body.next_runs).toEqual([]);
    const badCron = await preview("/api/automations", { cron: "not cron", timezone: "UTC" });
    expect(badCron.status).toBe(400);
    expect(badCron.body.error).toBe("cron must be a valid 5-field expression");
    expect((await preview("/api/automations", {})).status).toBe(400);
    const badZone = await preview("/api/automations", { cron: "0 9 * * *", timezone: "Mars/Olympus" });
    expect(badZone.status).toBe(400);
    expect(badZone.body.error).toBe("timezone must be a valid IANA name");
    // A cron no person types (a valid list run to 600 characters) is refused
    // before anything parses it.
    const long = await preview("/api/automations", { cron: `${"0,".repeat(300)}0 9 * * *`, timezone: "UTC" });
    expect(long.status).toBe(400);
    expect(long.body.error).toBe("cron must be a valid 5-field expression");
  });

  test("the preview starts in the current minute, as the tick would fire a schedule enabled now", () => {
    expect(previewNextRuns({ cron: "0 9 * * *", timezone: "UTC" }, new Date("2026-10-18T09:00:10Z")))
      .toEqual(["2026-10-18T09:00:00.000Z", "2026-10-19T09:00:00.000Z", "2026-10-20T09:00:00.000Z"]);
  });

  test("the preview follows the scheduler's rule: a fixed time once across Lord Howe's half-hour fall-back", () => {
    expect(previewNextRuns({ cron: "45 1 * * *", timezone: "Australia/Lord_Howe" }, new Date("2026-04-04T14:00:00Z")))
      .toEqual(["2026-04-04T14:45:00.000Z", "2026-04-05T15:15:00.000Z", "2026-04-06T15:15:00.000Z"]);
  });

  test("canonical automations route creates and lists with the automation envelope", async () => {
    const s = await createOrgSession("automation-route");

    const created = await json<ApiSchedule>("/api/automations", {
      method: "POST",
      body: {
        name: "Automation route smoke",
        cron: "0 11 * * 1-5",
        prompt: "prepare a weekday status note",
        engine: "mock",
      },
      cookies: s.cookies,
    });
    expect(created.status).toBe(201);
    expect(created.body.enabled).toBe(false);

    const listed = await json<AutomationListResponse>("/api/automations", {
      cookies: s.cookies,
    });
    expect(listed.status).toBe(200);
    expect(listed.body.automations.some((item) => item.id === created.body.id)).toBe(true);
    expect(listed.body.schedules).toEqual(listed.body.automations);
  });

  test("POST validates name, cron, prompt, engine", async () => {
    const s = await createOrgSession("sched-validate");

    const noName = await json<unknown>("/api/schedules", {
      method: "POST",
      body: { cron: "* * * * *", prompt: "hi" },
      cookies: s.cookies,
    });
    expect(noName.status).toBe(400);

    const badCron = await json<unknown>("/api/schedules", {
      method: "POST",
      body: { name: "x", cron: "not a cron", prompt: "hi" },
      cookies: s.cookies,
    });
    expect(badCron.status).toBe(400);

    const noPrompt = await json<unknown>("/api/schedules", {
      method: "POST",
      body: { name: "x", cron: "* * * * *" },
      cookies: s.cookies,
    });
    expect(noPrompt.status).toBe(400);

    const oversized = await json<{ error: string }>("/api/schedules", {
      method: "POST",
      body: {
        name: "oversized",
        cron: "* * * * *",
        prompt: "x".repeat(RUN_PROMPT_MAX_CHARS + 1),
        engine: "mock",
      },
      cookies: s.cookies,
    });
    expect(oversized.status).toBe(413);
    expect(oversized.body.error).toBe("prompt_too_large");

    const badEngine = await json<unknown>("/api/schedules", {
      method: "POST",
      body: { name: "x", cron: "* * * * *", prompt: "hi", engine: "nope" },
      cookies: s.cookies,
    });
    expect(badEngine.status).toBe(400);
  });

  test("create → disabled by default → appears in list", async () => {
    const s = await createOrgSession("sched-create");
    const created = await createSchedule(s.cookies, {
      name: "Nightly audit",
      cron: "0 2 * * *",
      prompt: "audit dependencies",
      engine: "mock",
    });

    // KiroCrew's safety default: never enabled on create.
    expect(created.enabled).toBe(false);
    expect(created.name).toBe("Nightly audit");
    expect(created.cron).toBe("0 2 * * *");
    expect(created.engine).toBe("mock");
    expect(created.model).toBe("claude-opus-5"); // server default
    expect(created.last_fired_at).toBeNull();
    expect(typeof created.created_at).toBe("string");

    const list = await json<AutomationListResponse>("/api/schedules", {
      cookies: s.cookies,
    });
    expect(list.status).toBe(200);
    expect(list.body.schedules.some((x) => x.id === created.id)).toBe(true);
  });

  test("allows an unavailable provider draft but refuses to enable it", async () => {
    const s = await createOrgSession("sched-unready-draft");
    const previousEngine = process.env.ENGINE_READINESS_CODEX;
    try {
      process.env.ENGINE_READINESS_CODEX = "failed";
      const created = await createSchedule(s.cookies, {
        name: "Provider recovery draft",
        cron: "0 4 * * *",
        prompt: "run after provider recovery",
        engine: "codex",
        model: "gpt-5.6-sol",
      });
      expect(created.enabled).toBe(false);

      const enabled = await json<EngineModelNotReadyResponse>(`/api/schedules/${created.id}`, {
        method: "PATCH",
        body: { enabled: true },
        cookies: s.cookies,
      });
      expect(enabled.status).toBe(403);
      expect(enabled.body).toMatchObject({
        error: "engine_model_not_ready",
        engine: "codex",
        model: "gpt-5.6-sol",
      });
    } finally {
      if (previousEngine === undefined) delete process.env.ENGINE_READINESS_CODEX;
      else process.env.ENGINE_READINESS_CODEX = previousEngine;
    }
  });

  test("PATCH enable/disable/edit; 404 for unknown id", async () => {
    const s = await createOrgSession("sched-patch");
    const created = await createSchedule(s.cookies, {
      name: "Weekly notes",
      cron: "0 9 * * 1",
      prompt: "write release notes",
      engine: "mock",
    });

    const enabled = await json<ApiSchedule>(`/api/schedules/${created.id}`, {
      method: "PATCH",
      body: { enabled: true },
      cookies: s.cookies,
    });
    expect(enabled.status).toBe(200);
    expect(enabled.body.enabled).toBe(true);

    const edited = await json<ApiSchedule>(`/api/schedules/${created.id}`, {
      method: "PATCH",
      body: { name: "Weekly notes v2", cron: "0 10 * * 1", enabled: false },
      cookies: s.cookies,
    });
    expect(edited.status).toBe(200);
    expect(edited.body.name).toBe("Weekly notes v2");
    expect(edited.body.cron).toBe("0 10 * * 1");
    expect(edited.body.enabled).toBe(false);

    // Invalid cron on edit is rejected.
    const badEdit = await json<unknown>(`/api/schedules/${created.id}`, {
      method: "PATCH",
      body: { cron: "99 * * * *" },
      cookies: s.cookies,
    });
    expect(badEdit.status).toBe(400);

    const missing = await json<unknown>(`/api/schedules/${crypto.randomUUID()}`, {
      method: "PATCH",
      body: { enabled: true },
      cookies: s.cookies,
    });
    expect(missing.status).toBe(404);
  });

  test("run-now creates a REAL run and records a manual firing", async () => {
    const s = await createOrgSession("sched-runnow");
    const created = await createSchedule(s.cookies, {
      name: "Manual run",
      cron: "0 3 * * *",
      prompt: "do the thing",
      engine: "mock",
    });

    const fired = await json<RunNowResponse>(
      `/api/schedules/${created.id}/run-now`,
      { method: "POST", cookies: s.cookies },
    );
    expect(fired.status).toBe(201);
    const runId = fired.body.run_id;
    expect(runId).toMatch(/[0-9a-f-]{36}/);

    // It is a genuine run in the runs log, scoped to the org, that completes.
    const done = await waitFor(async () => {
      const { body } = await json<ApiRun>(`/api/runs/${runId}`, {
        cookies: s.cookies,
      });
      return body.status === "completed" ? body : null;
    });
    expect(done.prompt).toBe("do the thing");
    const [persisted] = await db
      .select({ origin: runs.origin })
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1);
    expect(persisted?.origin).toBe(AUTOMATION_RUN_ORIGIN);

    // History shows the manual firing, enriched with the live run status.
    const hist = await json<FiringHistoryResponse>(
      `/api/schedules/${created.id}/history`,
      { cookies: s.cookies },
    );
    expect(hist.status).toBe(200);
    expect(hist.body.firings.length).toBe(1);
    const firing = hist.body.firings[0];
    if (!firing) throw new Error("expected one schedule firing");
    expect(firing.trigger).toBe("manual");
    expect(firing.run_id).toBe(runId);
    expect(firing.run_status).toBe("completed");

    // The list (what the card reads) reports the manual firing as the last run
    // even though the cron loop's last_fired_at guard was never stamped.
    const listed = await json<{ automations?: ApiSchedule[]; schedules?: ApiSchedule[] }>(
      "/api/schedules",
      { cookies: s.cookies },
    );
    const mine = (listed.body.schedules ?? listed.body.automations ?? []).find(
      (item) => item.id === created.id,
    );
    expect(mine?.last_fired_at).toBeNull();
    expect(mine?.last_run_at).toBe(firing.fired_at);
  });

  test("run-now fails before persistence when a linked resource is unavailable", async () => {
    const s = await createOrgSession("sched-resource-gate");
    const marker = crypto.randomUUID();
    const created = await createSchedule(s.cookies, {
      name: "Resource-gated automation",
      cron: "0 3 * * *",
      prompt: `test ${marker} https://github.com/upstream-org/backend/pull/19625`,
      engine: "mock",
    });

    const fired = await json<{ error: string; message: string }>(
      `/api/schedules/${created.id}/run-now`,
      { method: "POST", cookies: s.cookies },
    );
    expect(fired.status).toBe(403);
    expect(fired.body.error).toBe("resource_unauthorized");

    const runs = await json<{ runs: ApiRun[] }>("/api/runs?all=1", {
      cookies: s.cookies,
    });
    expect(runs.body.runs.some((run) => run.prompt.includes(marker))).toBe(false);
    const history = await json<FiringHistoryResponse>(
      `/api/schedules/${created.id}/history`,
      { cookies: s.cookies },
    );
    expect(history.body.firings).toEqual([]);
  });

  test("run-now fails closed before persistence when a pinned automation revision is gone", async () => {
    const s = await createOrgSession("sched-skill-integrity");
    const skill = await createSkill(s.cookies);
    const created = await createSchedule(s.cookies, {
      name: "Pinned automation",
      cron: "0 3 * * *",
      prompt: "must use the pinned procedure",
      engine: "mock",
      skill: { id: skill.id },
    });
    expect(created.skill_id).toBe(skill.id);
    expect(created.skill_version).toBe(skill.current_version);
    expect(created.skill_content_hash).toBeString();

    await db
      .delete(skillRevisions)
      .where(
        and(
          eq(skillRevisions.skillId, skill.id),
          eq(skillRevisions.version, skill.current_version),
        ),
      );

    const fired = await json<{ error: string; detail: string }>(
      `/api/schedules/${created.id}/run-now`,
      { method: "POST", cookies: s.cookies },
    );
    expect(fired.status).toBe(409);
    expect(fired.body.error).toBe("missing_skill_revision");

    const runs = await json<{ runs: ApiRun[] }>("/api/runs?all=1", {
      cookies: s.cookies,
    });
    expect(runs.body.runs.some((run) => run.prompt === "must use the pinned procedure")).toBe(
      false,
    );
    const history = await json<FiringHistoryResponse>(
      `/api/schedules/${created.id}/history`,
      { cookies: s.cookies },
    );
    expect(history.body.firings).toEqual([]);
  });

  test("a durable schedule occurrence replays before unavailable resource preflight", async () => {
    const s = await createOrgSession("sched-occurrence-replay");
    const prompt = "test https://github.com/acme/api/pull/42";
    const created = await createSchedule(s.cookies, {
      name: "Replay resource occurrence",
      cron: "31 5 * * *",
      prompt,
      engine: "mock",
    });
    const schedule = await getScheduleForOrg(s.orgId, created.id);
    if (!schedule) throw new Error("expected schedule");
    const occurrence = new Date("2026-08-21T05:31:42.000Z");
    const key = firingKey(schedule.id, "cron", occurrence);
    const runId = crypto.randomUUID();
    const intent: RunCommandIntent = {
      prompt,
      model: schedule.model,
      engine: schedule.engine,
      parentRunId: null,
      requestedRepos: schedule.repos,
      requestedResources: [],
      attachmentIds: [],
      memoryScope: "org",
      skillId: schedule.skillId,
      skillVersion: schedule.skillVersion,
      commandName: null,
      commandProvider: null,
      commandSessionId: null,
      commandCatalogRevision: null,
    };
    await acceptRunCommand({
      idempotencyKey: key,
      orgId: schedule.orgId,
      actorId: schedule.userId,
      intent,
      run: {
        id: runId,
        prompt,
        model: schedule.model,
        engine: schedule.engine,
        parentRunId: null,
        threadId: runId,
        repos: ["acme/api:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
        resolvedResources: [],
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

    const replay = await fireScheduleWithOutcome(schedule, "cron", occurrence);
    expect(replay).toMatchObject({ runId, created: false, firingRecorded: true });
  });

  test("a stored dynamic free model still fires after the lane rotates it out", async () => {
    const s = await createOrgSession("schedule-free-model-restart");
    const model = "vendor/rotated-out:free";
    freeModelLaneCache.reset();
    try {
      freeModelLaneCache.adoptRegistryLane([model]);
      const created = await createSchedule(s.cookies, {
        name: "Durable free model",
        cron: "37 5 * * *",
        prompt: "run with the stored free model",
        engine: "opencode",
        model,
      });
      const schedule = await getScheduleForOrg(s.orgId, created.id);
      if (!schedule) throw new Error("expected schedule");

      freeModelLaneCache.reset();
      const fired = await fireScheduleWithOutcome(
        schedule,
        "cron",
        new Date("2026-08-27T05:37:00.000Z"),
      );
      expect(fired.created).toBe(true);
    } finally {
      freeModelLaneCache.reset();
    }
  });

  test("org isolation: another org cannot see, patch, run, or read history", async () => {
    const owner = await createOrgSession("sched-owner");
    const other = await createOrgSession("sched-other");
    const created = await createSchedule(owner.cookies, {
      name: "Private",
      cron: "0 4 * * *",
      prompt: "secret",
      engine: "mock",
    });

    const list = await json<AutomationListResponse>("/api/schedules", {
      cookies: other.cookies,
    });
    expect(list.body.schedules.some((x) => x.id === created.id)).toBe(false);

    const patch = await json<unknown>(`/api/schedules/${created.id}`, {
      method: "PATCH",
      body: { enabled: true },
      cookies: other.cookies,
    });
    expect(patch.status).toBe(404);

    const run = await json<unknown>(`/api/schedules/${created.id}/run-now`, {
      method: "POST",
      cookies: other.cookies,
    });
    expect(run.status).toBe(404);

    const hist = await json<unknown>(`/api/schedules/${created.id}/history`, {
      cookies: other.cookies,
    });
    expect(hist.status).toBe(404);

    const del = await json<unknown>(`/api/schedules/${created.id}`, {
      method: "DELETE",
      cookies: other.cookies,
    });
    expect(del.status).toBe(404);
  });

  test("DELETE removes an owned schedule and its firing projection", async () => {
    const s = await createOrgSession("sched-delete");
    const created = await createSchedule(s.cookies, {
      name: "Temporary automation",
      cron: "0 5 * * *",
      prompt: "temporary",
      engine: "mock",
    });
    const fired = await json<RunNowResponse>(
      `/api/schedules/${created.id}/run-now`,
      { method: "POST", cookies: s.cookies },
    );
    expect(fired.status).toBe(201);

    const deleted = await json<unknown>(`/api/schedules/${created.id}`, {
      method: "DELETE",
      cookies: s.cookies,
    });
    expect(deleted.status).toBe(204);

    const list = await json<AutomationListResponse>("/api/schedules", {
      cookies: s.cookies,
    });
    expect(list.body.schedules.some((x) => x.id === created.id)).toBe(false);

    const history = await json<unknown>(`/api/schedules/${created.id}/history`, {
      cookies: s.cookies,
    });
    expect(history.status).toBe(404);

    const deletedAgain = await json<unknown>(`/api/schedules/${created.id}`, {
      method: "DELETE",
      cookies: s.cookies,
    });
    expect(deletedAgain.status).toBe(404);
  });

  test("scheduler tick fires an enabled, due schedule once per minute", async () => {
    const s = await createOrgSession("sched-tick");
    const created = await createSchedule(s.cookies, {
      name: "Every minute",
      cron: "* * * * *",
      prompt: "tick fire",
      engine: "mock",
    });
    // Enable it so the loop will fire it.
    await json<unknown>(`/api/schedules/${created.id}`, {
      method: "PATCH",
      body: { enabled: true },
      cookies: s.cookies,
    });

    const now = new Date(Date.UTC(2026, 7, 5, 10, 30, 15)); // matches "* * * * *"
    await tick(now);

    const afterFirst = await json<FiringHistoryResponse>(
      `/api/schedules/${created.id}/history`,
      { cookies: s.cookies },
    );
    const mine = afterFirst.body.firings.filter((f) => f.trigger === "cron");
    expect(mine.length).toBe(1);

    // A second tick in the SAME minute must NOT double-fire.
    await tick(new Date(Date.UTC(2026, 7, 5, 10, 30, 59)));
    const afterSame = await json<FiringHistoryResponse>(
      `/api/schedules/${created.id}/history`,
      { cookies: s.cookies },
    );
    expect(afterSame.body.firings.filter((f) => f.trigger === "cron").length).toBe(1);

    // A tick in the NEXT minute fires again.
    await tick(new Date(Date.UTC(2026, 7, 5, 10, 31, 5)));
    const afterNext = await json<FiringHistoryResponse>(
      `/api/schedules/${created.id}/history`,
      { cookies: s.cookies },
    );
    expect(afterNext.body.firings.filter((f) => f.trigger === "cron").length).toBe(2);

    // Clean up so the always-on loop doesn't keep firing this in later suites.
    await json<unknown>(`/api/schedules/${created.id}`, {
      method: "PATCH",
      body: { enabled: false },
      cookies: s.cookies,
    });
  });

  test("scheduler fire publishes exactly one automation invalidation", async () => {
    const session = await createOrgSession("sched-realtime");
    const created = await createSchedule(session.cookies, {
      name: "Scheduler realtime invalidation",
      cron: "45 12 5 8 *",
      prompt: "scheduled realtime",
      engine: "mock",
    });
    const enabled = await json<ApiSchedule>(`/api/schedules/${created.id}`, {
      method: "PATCH",
      body: { enabled: true },
      cookies: session.cookies,
    });
    expect(enabled.status).toBe(200);

    const changes: OrgChange[] = [];
    const unsubscribe = subscribeOrg(session.orgId, (change) => {
      if (change.type === "automation") changes.push(change);
    });
    try {
      await tick(new Date(Date.UTC(2026, 7, 5, 12, 45, 0)));
      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({
        type: "automation",
        action: "fired",
        automationId: created.id,
      });
      if (changes[0]?.type !== "automation" || changes[0].action !== "fired") {
        throw new Error("expected one fired automation invalidation");
      }
      expect(changes[0].runId).toMatch(/[0-9a-f-]{36}/);
    } finally {
      unsubscribe();
      await json<unknown>(`/api/schedules/${created.id}`, {
        method: "PATCH",
        body: { enabled: false },
        cookies: session.cookies,
      });
    }
  });

  test("the tick fires a fixed time once across a fall-back and right after a spring-forward gap", async () => {
    const s = await createOrgSession("sched-dst");
    const cronFirings = async (id: string) =>
      (await json<FiringHistoryResponse>(`/api/schedules/${id}/history`, { cookies: s.cookies })).body.firings
        .filter((firing) => firing.trigger === "cron").length;
    const enabled = async (cron: string, timezone: string) => {
      const created = await createSchedule(s.cookies, { name: `dst ${cron} ${timezone}`, cron, timezone, prompt: "dst", engine: "mock" });
      await json(`/api/schedules/${created.id}`, { method: "PATCH", body: { enabled: true }, cookies: s.cookies });
      return created.id;
    };
    // Lord Howe moves half an hour. 2026-04-05: 01:45 LHDT is 14:45Z and the
    // fall-back repeats 01:45 at 15:15Z (LHST). 2026-10-04: 02:00 LHST (15:30Z)
    // becomes 02:30 LHDT, so 02:15 does not exist and fires at 15:30Z.
    const fall = await enabled("45 1 4,5 4 *", "Australia/Lord_Howe");
    const spring = await enabled("15 2 3,4 10 *", "Australia/Lord_Howe");
    // New York 2026-03-08: 02:00-02:59 does not exist; 03:00 EDT is 07:00Z.
    const newYork = await enabled("30 2 8 3 *", "America/New_York");
    try {
      await tick(new Date("2026-04-04T14:45:10Z"));
      await tick(new Date("2026-04-04T15:15:10Z"));
      expect(await cronFirings(fall)).toBe(1);
      await tick(new Date("2026-10-03T15:30:10Z"));
      expect(await cronFirings(spring)).toBe(1);
      await tick(new Date("2026-03-08T07:00:10Z"));
      expect(await cronFirings(newYork)).toBe(1);
    } finally {
      for (const id of [fall, spring, newYork]) {
        await json(`/api/schedules/${id}`, { method: "PATCH", body: { enabled: false }, cookies: s.cookies });
      }
    }
  });

  test("a tick over many schedules whose cron names no date stays one minute's check each", async () => {
    const s = await createOrgSession("sched-rare");
    await db.execute(sql`
      insert into schedules (org_id, name, cron, timezone, prompt, engine, model, enabled)
      select ${s.orgId}, 'never ' || n, '0 0 31 2 *', 'America/New_York', 'never', 'mock', 'm', true
      from generate_series(1, 400) as n`);
    try {
      const started = performance.now();
      await tick(new Date("2026-08-05T10:30:15Z"));
      // A nine-year search per schedule takes about 13 ms each, over 5 s here.
      expect(performance.now() - started).toBeLessThan(2_000);
    } finally {
      await db.execute(sql`delete from schedules where org_id = ${s.orgId}`);
    }
  });

  test("listing many schedules whose cron names no date stays short", async () => {
    const s = await createOrgSession("sched-rare-list");
    await db.execute(sql`
      insert into schedules (org_id, name, cron, timezone, prompt, engine, model, enabled)
      select ${s.orgId}, 'never ' || n, '0 0 31 2 *', 'America/New_York', 'never', 'mock', 'm', true
      from generate_series(1, 400) as n`);
    try {
      const started = performance.now();
      const listed = await json<AutomationListResponse>("/api/automations", { cookies: s.cookies });
      // A nine-year walk per schedule takes about 13 ms each, over 5 s here.
      expect(performance.now() - started).toBeLessThan(2_000);
      expect(listed.body.automations).toHaveLength(400);
      expect(listed.body.automations.every((automation) => automation.next_due_at === null)).toBe(true);
    } finally {
      await db.execute(sql`delete from schedules where org_id = ${s.orgId}`);
    }
  });

  test("a run-now stamped in the next minute, read by a tick late in this one, does not hide this minute's run", async () => {
    const s = await createOrgSession("sched-stamp");
    const created = await createSchedule(s.cookies, { name: "Noon", cron: "0 12 * * *", timezone: "UTC", prompt: "noon", engine: "mock" });
    await json(`/api/schedules/${created.id}`, { method: "PATCH", body: { enabled: true }, cookies: s.cookies });
    try {
      // The tick took 12:00:59; before it read the schedules, a run-now
      // (bots/routes.ts markFired) stamped 12:01:00.
      await db.execute(sql`update schedules set last_fired_at = '2026-08-05T12:01:00Z' where id = ${created.id}`);
      await tick(new Date("2026-08-05T12:00:59Z"));
      const history = await json<FiringHistoryResponse>(`/api/schedules/${created.id}/history`, { cookies: s.cookies });
      expect(history.body.firings.filter((firing) => firing.trigger === "cron")).toHaveLength(1);
      const record = (await getScheduleForOrg(s.orgId, created.id))!;
      expect(nextRunAt({ ...record, lastFiredAt: new Date("2026-08-05T12:01:00Z") }, new Date("2026-08-05T12:00:59Z"))?.toISOString())
        .toBe("2026-08-05T12:00:00.000Z");
      expect(nextRunAt({ ...record, lastFiredAt: new Date("2026-08-05T12:00:10Z") }, new Date("2026-08-05T12:00:59Z"))?.toISOString())
        .toBe("2026-08-06T12:00:00.000Z");
    } finally {
      await json(`/api/schedules/${created.id}`, { method: "PATCH", body: { enabled: false }, cookies: s.cookies });
    }
  });

  test("the API's next run is the minute the tick fires next, on the schedule's clock", async () => {
    const s = await createOrgSession("sched-next-run");
    const created = await createSchedule(s.cookies, { name: "Island", cron: "45 1 * * *", timezone: "Australia/Lord_Howe", prompt: "next", engine: "mock" });
    expect(created.next_due_at).toBeNull();
    const enabled = await json<ApiSchedule>(`/api/schedules/${created.id}`, { method: "PATCH", body: { enabled: true }, cookies: s.cookies });
    try {
      const next = enabled.body.next_due_at;
      expect(next).not.toBeNull();
      const wall = new Intl.DateTimeFormat("en-GB", { timeZone: "Australia/Lord_Howe", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
      expect(wall.format(new Date(next!))).toBe("01:45");
      expect(Date.parse(next!)).toBeGreaterThan(Date.now() - 60_000);
      expect(Date.parse(next!)).toBeLessThan(Date.now() + 25 * 3_600_000);
      const listed = await json<AutomationListResponse>("/api/automations", { cookies: s.cookies });
      expect(listed.body.automations.find((automation) => automation.id === created.id)?.next_due_at).toBe(next);
      // The tick fires in exactly the minute the API named, not the one before.
      const cronFirings = async () =>
        (await json<FiringHistoryResponse>(`/api/schedules/${created.id}/history`, { cookies: s.cookies })).body.firings
          .filter((firing) => firing.trigger === "cron").length;
      await tick(new Date(Date.parse(next!) - 40_000));
      expect(await cronFirings()).toBe(0);
      await tick(new Date(Date.parse(next!) + 20_000));
      expect(await cronFirings()).toBe(1);
    } finally {
      const paused = await json<ApiSchedule>(`/api/schedules/${created.id}`, { method: "PATCH", body: { enabled: false }, cookies: s.cookies });
      expect(paused.body.next_due_at).toBeNull();
    }
  });
});
