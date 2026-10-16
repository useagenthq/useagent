import { describe, expect, test } from "bun:test";
import {
  automationEditorEngineOptions,
  automationEngineOptions,
  cadenceLabel,
  engineLabel,
  isValidCron,
  nextRunAt,
  nextRunLabel,
  reconcileAutomationEngine,
  scheduleZone,
} from "@/app/agent/schedules/schedules-data";

describe("automation presentation", () => {
  test("explains supported cadence patterns without hiding cron semantics", () => {
    expect(cadenceLabel("0 9 * * 1-5")).toBe("Weekdays at 9:00 AM");
    expect(cadenceLabel("30 14 * * *")).toBe("Every day at 2:30 PM");
    expect(cadenceLabel("0 7 * * 1")).toBe("Every Monday at 7:00 AM");
    expect(cadenceLabel("*/15 * * * *")).toBe("Every 15 minutes");
    expect(cadenceLabel("5 4 1 * *")).toBe("5 4 1 * *");
  });

  test("labels explicit and server timezones honestly", () => {
    expect(scheduleZone({ timezone: "Asia/Kolkata" })).toBe("Asia/Kolkata");
    expect(scheduleZone({ timezone: null })).toBe("Server timezone");
  });

  test("offers only current engines enabled by the server catalog", () => {
    expect(automationEngineOptions(["claude", "opencode"])).toEqual([
      { id: "opencode", label: "OpenCode" },
      { id: "claude", label: "Claude Code" },
    ]);
    expect(automationEngineOptions(["codex"])).toEqual([{ id: "codex", label: "Codex" }]);
  });

  test("keeps legacy engine ids displayable without making them selectable", () => {
    expect(engineLabel("claude-sdk")).toBe("Claude SDK");
    // The legacy engine id reads as a place, never as the vendor it was named after.
    expect(engineLabel("daytona")).toBe("Cloud");
    expect(engineLabel("acp")).toBe("ACP");
    expect(automationEngineOptions(["claude-sdk", "daytona", "acp"])).toEqual([]);
  });

  test("preserves an unavailable stored engine only while editing its draft", () => {
    expect(automationEditorEngineOptions(["codex"], "claude-sdk")).toEqual([
      { id: "claude-sdk", label: "Claude SDK (unavailable)" },
      { id: "codex", label: "Codex" },
    ]);
    expect(automationEditorEngineOptions(["codex"], "codex")).toEqual([
      { id: "codex", label: "Codex" },
    ]);
  });

  test("reconciles new Automation drafts with live engine capabilities", () => {
    const options = automationEngineOptions(["opencode", "codex"]);
    expect(reconcileAutomationEngine(options, "codex")).toBe("codex");
    expect(reconcileAutomationEngine(options, "")).toBe("opencode");
    expect(reconcileAutomationEngine(options, "claude")).toBe("opencode");
    expect(reconcileAutomationEngine([], "codex")).toBe("");
  });
});

describe("plain-words schedules and next run", () => {
  test("reads lists and ranges of days as words", () => {
    expect(cadenceLabel("30 8 * * 2,4")).toBe("Tuesdays and Thursdays at 8:30 AM");
    expect(cadenceLabel("0 9 * * 1,3,5")).toBe("Mondays, Wednesdays and Fridays at 9:00 AM");
    expect(cadenceLabel("0 9 * * 2-4")).toBe("Tuesdays, Wednesdays and Thursdays at 9:00 AM");
    expect(cadenceLabel("0 9 * * 0,6")).toBe("Weekends at 9:00 AM");
    expect(cadenceLabel("0 9 * * 6,0")).toBe("Weekends at 9:00 AM");
    expect(cadenceLabel("0 9 * * 7")).toBe("Every Sunday at 9:00 AM");
  });

  test("rejects expressions the scheduler would reject", () => {
    expect(isValidCron("30 8 * * 2,4")).toBe(true);
    expect(isValidCron("0 9 * * 1-5")).toBe(true);
    expect(isValidCron("0 9 * *")).toBe(false);
    expect(isValidCron("61 9 * * *")).toBe(false);
    expect(isValidCron("0 9 * * 8")).toBe(false);
    expect(isValidCron("0 9 32 * *")).toBe(false);
    expect(isValidCron("not a cron")).toBe(false);
    expect(isValidCron("")).toBe(false);
  });

  test("finds the next run for custom schedules", () => {
    // Tuesdays and Thursdays at 8:30; from Monday midnight, Tuesday is next.
    expect(nextRunAt("30 8 * * 2,4", "UTC", new Date("2026-10-12T00:00:00Z"))?.toISOString()).toBe("2026-10-13T08:30:00.000Z");
    // Every 30 minutes.
    expect(nextRunAt("*/30 * * * *", "UTC", new Date("2026-10-13T10:07:00Z"))?.toISOString()).toBe("2026-10-13T10:30:00.000Z");
    // Weekdays at 9:00; Friday's run has already gone, so Monday is next.
    expect(nextRunAt("0 9 * * 1-5", "UTC", new Date("2026-10-16T10:00:00Z"))?.toISOString()).toBe("2026-10-19T09:00:00.000Z");
    // Day-of-month OR day-of-week, like the scheduler: the 15th beats Monday.
    expect(nextRunAt("0 0 15 * 1", "UTC", new Date("2026-10-14T00:00:00Z"))?.toISOString()).toBe("2026-10-15T00:00:00.000Z");
  });

  test("honours the routine's timezone, including which day it is there", () => {
    // 9:00 in New York is 13:00 UTC in October; from 12:00 UTC it is today.
    expect(nextRunAt("0 9 * * *", "America/New_York", new Date("2026-10-13T12:00:00Z"))?.toISOString()).toBe("2026-10-13T13:00:00.000Z");
    expect(nextRunLabel("0 9 * * *", "America/New_York", new Date("2026-10-13T12:00:00Z"))).toBe("Tuesday at 9:00 AM");
    // Tuesdays 9:00 in Auckland: from Monday 00:00 UTC it is already Monday
    // lunchtime there, and the run lands on Monday in UTC terms.
    expect(nextRunAt("0 9 * * 2", "Pacific/Auckland", new Date("2026-10-12T00:00:00Z"))?.toISOString()).toBe("2026-10-12T20:00:00.000Z");
    expect(nextRunLabel("0 9 * * 2", "Pacific/Auckland", new Date("2026-10-12T00:00:00Z"))).toBe("Tuesday at 9:00 AM");
  });

  test("labels the next run with a day and a time", () => {
    expect(nextRunLabel("0 9 * * *", "UTC", new Date("2026-10-13T00:00:00Z"))).toBe("Tuesday at 9:00 AM");
    expect(nextRunLabel("30 8 * * 2,4", "UTC", new Date("2026-10-12T00:00:00Z"))).toBe("Tuesday at 8:30 AM");
  });

  test("has no next run to show for invalid or impossible expressions", () => {
    expect(nextRunAt("0 9 * *", "UTC", new Date("2026-10-13T00:00:00Z"))).toBeNull();
    expect(nextRunLabel("0 9 * *", "UTC", new Date("2026-10-13T00:00:00Z"))).toBeNull();
    // February 30 never fires.
    expect(nextRunAt("0 0 30 2 *", "UTC", new Date("2026-10-13T00:00:00Z"))).toBeNull();
    // But February 29 does, given a long enough look ahead.
    expect(nextRunAt("0 12 29 2 *", "UTC", new Date("2027-03-01T00:00:00Z"))?.toISOString()).toBe("2028-02-29T12:00:00.000Z");
  });
});
