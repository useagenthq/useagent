import { describe, expect, test } from "bun:test";
import type { ApiRun } from "../src/runs/repo";
import { subscribeOrg, type OrgChange } from "../src/runs/org-signals";
import type { ApiFiring, ApiSchedule } from "../src/schedules/repo";
import { tick } from "../src/schedules/scheduler";
import { createOrgSession, json, waitFor } from "./helpers";

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

describe("schedules API", () => {
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

    // reference bot safety default: never enabled on create.
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

    const now = new Date(2026, 7, 5, 10, 30, 15); // matches "* * * * *"
    await tick(now);

    const afterFirst = await json<FiringHistoryResponse>(
      `/api/schedules/${created.id}/history`,
      { cookies: s.cookies },
    );
    const mine = afterFirst.body.firings.filter((f) => f.trigger === "cron");
    expect(mine.length).toBe(1);

    // A second tick in the SAME minute must NOT double-fire.
    await tick(new Date(2026, 7, 5, 10, 30, 59));
    const afterSame = await json<FiringHistoryResponse>(
      `/api/schedules/${created.id}/history`,
      { cookies: s.cookies },
    );
    expect(afterSame.body.firings.filter((f) => f.trigger === "cron").length).toBe(1);

    // A tick in the NEXT minute fires again.
    await tick(new Date(2026, 7, 5, 10, 31, 5));
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
      await tick(new Date(2026, 7, 5, 12, 45, 0));
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
});
