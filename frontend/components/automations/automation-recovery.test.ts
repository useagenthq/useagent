import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { AUTOMATION_RECOVERY_DELAYS_MS } from "@/app/agent/schedules/use-automation-recovery";

const readScheduleSource = (name: string): string =>
  readFileSync(new URL(`../../app/agent/schedules/${name}`, import.meta.url), "utf8");

describe("automation recovery", () => {
  test("uses a finite, low-frequency snapshot recovery window", () => {
    expect(AUTOMATION_RECOVERY_DELAYS_MS).toEqual([5_000, 15_000, 30_000]);
    expect(AUTOMATION_RECOVERY_DELAYS_MS.every(Number.isFinite)).toBeTrue();
  });

  test("combines live invalidations with bounded recovery instead of permanent polling", () => {
    for (const file of ["automations-view.tsx", "automation-history-drawer.tsx"]) {
      const source = readScheduleSource(file);
      expect(source).toContain("useOrgChanges");
      expect(source).toContain("useAutomationRecovery");
      expect(source).not.toContain("setInterval(");
    }
  });

  test("selects Automation agents from live capabilities without guessing Codex", () => {
    const editor = readScheduleSource("new-schedule-modal.tsx");
    expect(editor).toContain("useEnabledEngines");
    expect(editor).toContain("automationEditorEngineOptions");
    expect(editor).not.toContain("SCHEDULE_ENGINES");
    expect(editor).not.toContain('useState("codex")');
  });
});
