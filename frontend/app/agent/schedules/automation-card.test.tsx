import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AutomationCard } from "./automation-card";
import { lastRunAt, type ScheduleRecord } from "./schedules-data";

function schedule(overrides: Partial<ScheduleRecord> = {}): ScheduleRecord {
  return {
    id: "auto-1",
    org_id: "org-1",
    user_id: "user-1",
    name: "Nightly digest",
    cron: "0 9 * * *",
    timezone: "UTC",
    prompt: "Summarize yesterday",
    engine: "chat",
    model: "claude-sonnet-5",
    skill_id: null,
    skill_version: null,
    skill_content_hash: null,
    repos: [],
    tags: [],
    delivery: null,
    notifications: null,
    run_actor_id: null,
    concurrency: null,
    queue: null,
    cost_limits: null,
    frequency_limits: null,
    approval_policy: null,
    enablement_policy: null,
    enabled: true,
    last_fired_at: null,
    last_run_at: null,
    created_at: "2026-09-01T09:00:00Z",
    updated_at: "2026-09-01T09:00:00Z",
    ...overrides,
  };
}

const render = (record: ScheduleRecord) =>
  renderToStaticMarkup(
    <AutomationCard
      schedule={record}
      running={false}
      mutating={false}
      onToggle={() => {}}
      onRunNow={() => {}}
      onHistory={() => {}}
      onEdit={() => {}}
      onDelete={async () => {}}
    />,
  );

test("a manual Run now counts as the last run even when the cron guard was never stamped", () => {
  const recent = new Date(Date.now() - 3 * 60_000).toISOString();
  expect(lastRunAt({ last_run_at: recent, last_fired_at: null })).toBe(recent);
  expect(render(schedule({ last_run_at: recent }))).toContain("Ran ");
  expect(render(schedule({ last_run_at: recent }))).not.toContain("Not run yet");
  expect(render(schedule())).toContain("Not run yet");
});
