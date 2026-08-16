import { describe, expect, test } from "bun:test";
import {
  automationEditorEngineOptions,
  automationEngineOptions,
  cadenceLabel,
  engineLabel,
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
    expect(engineLabel("daytona")).toBe("Daytona");
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
