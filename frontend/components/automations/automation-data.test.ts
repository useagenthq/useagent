import { describe, expect, test } from "bun:test";
import {
  automationEditorEngineOptions,
  automationEngineOptions,
  cadenceLabel,
  engineLabel,
  isValidCron,
  nextRunLabelAt,
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

  test("never turns an invalid expression into words", () => {
    // Minute 61 would otherwise read as "9:61 AM" on the list rows.
    expect(cadenceLabel("61 9 * * 2,4")).toBe("61 9 * * 2,4");
    expect(cadenceLabel("0 25 * * *")).toBe("0 25 * * *");
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

  test("renders the next run the server names, in the schedule's zone", () => {
    // 13:00 UTC is 9:00 in New York in October, on a Tuesday.
    expect(nextRunLabelAt("2026-10-13T13:00:00.000Z", "America/New_York")).toBe("Tuesday at 9:00 AM");
    // The same instant is already Wednesday in Auckland.
    expect(nextRunLabelAt("2026-10-13T13:00:00.000Z", "Pacific/Auckland")).toBe("Wednesday at 2:00 AM");
    // A fall-back instant the server picks renders at its own wall time.
    expect(nextRunLabelAt("2026-11-01T06:30:00.000Z", "America/New_York")).toBe("Sunday at 1:30 AM");
  });

  test("shows no next run when the server names none", () => {
    // Paused, or a cron that names no date: the server answers null.
    expect(nextRunLabelAt(null, "UTC")).toBeNull();
    // No zone to render the instant in.
    expect(nextRunLabelAt("2026-10-13T13:00:00.000Z", null)).toBeNull();
    expect(nextRunLabelAt("2026-10-13T13:00:00.000Z", "Not/AZone")).toBeNull();
    expect(nextRunLabelAt("not a date", "UTC")).toBeNull();
  });
});
