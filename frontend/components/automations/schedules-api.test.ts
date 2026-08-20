import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createSchedule,
  deleteSchedule,
  fetchHistory,
  fetchSchedules,
  runScheduleNow,
  updateSchedule,
} from "@/app/agent/schedules/schedules-api";
import type { FiringRecord, ScheduleRecord } from "@/app/agent/schedules/schedules-data";

interface FetchCall {
  input: RequestInfo | URL;
  init?: RequestInit;
}

const automation = {
  id: "automation-1",
  org_id: "org-1",
  user_id: "user-1",
  name: "Daily brief",
  cron: "0 9 * * *",
  timezone: "Asia/Kolkata",
  prompt: "Prepare the daily brief",
  engine: "opencode",
  model: "claude-haiku-4-5",
  skill_id: null,
  skill_version: null,
  skill_content_hash: null,
  repos: [],
  tags: [],
  delivery: null,
  notifications: null,
  run_actor_id: "user-1",
  concurrency: null,
  queue: null,
  cost_limits: null,
  frequency_limits: null,
  approval_policy: null,
  enablement_policy: null,
  enabled: false,
  last_fired_at: null,
  created_at: "2026-08-16T00:00:00.000Z",
  updated_at: "2026-08-16T00:00:00.000Z",
} satisfies ScheduleRecord;

const firing = {
  id: "firing-1",
  schedule_id: automation.id,
  run_id: "run-1",
  fired_at: "2026-08-16T00:01:00.000Z",
  trigger: "manual",
  status: "queued",
  run_status: "running",
  run_summary: null,
} satisfies FiringRecord;

const originalFetch = globalThis.fetch;
const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
let calls: FetchCall[] = [];
let responses: Response[] = [];

function plainHeaders(headers: HeadersInit | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  return Object.fromEntries(new Headers(headers).entries());
}

function normalizedCalls() {
  return calls.map(({ input, init }) => ({
    input,
    init: init
      ? {
          ...init,
          headers: plainHeaders(init.headers),
        }
      : init,
  }));
}

beforeEach(() => {
  calls = [];
  responses = [];
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
  globalThis.fetch = (async (input, init) => {
    calls.push({ input, init });
    const response = responses.shift();
    if (!response) throw new Error("missing mocked response");
    return response;
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
  else Reflect.deleteProperty(globalThis, "window");
});

describe("Automations API client", () => {
  test("loads the canonical Automations envelope with the caller's abort signal", async () => {
    responses.push(Response.json({ automations: [automation] }));
    const controller = new AbortController();

    const result = await fetchSchedules(controller.signal);

    expect(result).toEqual([automation]);
    expect(normalizedCalls()).toEqual([
      {
        input: "/api/automations",
        init: {
          cache: "no-store",
          credentials: "include",
          headers: {
            "x-skynet-client-release": "run-events-v1:dev",
          },
          signal: controller.signal,
        },
      },
    ]);
  });

  test("loads Automation history with the caller's abort signal", async () => {
    responses.push(Response.json({ firings: [firing] }));
    const controller = new AbortController();

    const result = await fetchHistory(automation.id, controller.signal);

    expect(result).toEqual([firing]);
    expect(normalizedCalls()).toEqual([
      {
        input: `/api/automations/${automation.id}/history`,
        init: {
          cache: "no-store",
          credentials: "include",
          headers: {
            "x-skynet-client-release": "run-events-v1:dev",
          },
          signal: controller.signal,
        },
      },
    ]);
  });

  test("creates an Automation through the canonical collection endpoint", async () => {
    responses.push(Response.json(automation));
    const input = {
      name: automation.name,
      cron: automation.cron,
      timezone: automation.timezone,
      prompt: automation.prompt,
      engine: automation.engine,
    };

    const result = await createSchedule(input);

    expect(result).toEqual(automation);
    expect(normalizedCalls()).toEqual([
      {
        input: "/api/automations",
        init: {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-skynet-client-release": "run-events-v1:dev",
          },
          body: JSON.stringify(input),
          credentials: "include",
        },
      },
    ]);
  });

  test("updates an Automation through its canonical item endpoint", async () => {
    responses.push(Response.json({ ...automation, enabled: true }));

    const result = await updateSchedule(automation.id, { enabled: true });

    expect(result.enabled).toBeTrue();
    expect(normalizedCalls()).toEqual([
      {
        input: `/api/automations/${automation.id}`,
        init: {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            "x-skynet-client-release": "run-events-v1:dev",
          },
          body: JSON.stringify({ enabled: true }),
          credentials: "include",
        },
      },
    ]);
  });

  test("starts an Automation through its canonical run-now endpoint", async () => {
    responses.push(Response.json({ run_id: firing.run_id }));

    const runId = await runScheduleNow(automation.id);

    expect(runId).toBe(firing.run_id);
    expect(normalizedCalls()).toEqual([
      {
        input: `/api/automations/${automation.id}/run-now`,
        init: {
          method: "POST",
          credentials: "include",
          headers: {
            "x-skynet-client-release": "run-events-v1:dev",
          },
        },
      },
    ]);
  });

  test("deletes an Automation through its canonical item endpoint", async () => {
    responses.push(new Response(null, { status: 204 }));

    await deleteSchedule(automation.id);

    expect(normalizedCalls()).toEqual([
      {
        input: `/api/automations/${automation.id}`,
        init: {
          method: "DELETE",
          credentials: "include",
          headers: {
            "x-skynet-client-release": "run-events-v1:dev",
          },
        },
      },
    ]);
  });
});
