import { describe, expect, test } from "bun:test";
import { toolStep } from "./tool-step";

describe("toolStep subagent branch", () => {
  test("labels a task call with a colon, not a dash", () => {
    const step = toolStep("task", { description: "Review the diff" }, undefined, undefined);
    expect(step).toMatchObject({
      kind: "task",
      chip: "subagent",
      label: "Subagent: Review the diff",
    });
    expect(step.label).not.toContain("\u2014");
  });

  test("falls back to the title, then to 'subagent'", () => {
    expect(toolStep("task", {}, "Plan it", undefined).label).toBe("Subagent: Plan it");
    expect(toolStep("task", {}, undefined, undefined).label).toBe("Subagent: subagent");
  });
});
