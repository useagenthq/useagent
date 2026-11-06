import { describe, expect, test } from "bun:test";
import { type ApiStep, deriveTrace } from "./types";

// Stored subagent steps carry the old "Subagent <em dash> desc" label; new ones use "Subagent: desc".
// With no description or prompt in the input, the title comes from the label, so both must parse.
function subagentStep(label: string): ApiStep {
  return {
    id: "s1",
    run_id: "r1",
    idx: 0,
    kind: "task",
    chip: "subagent",
    label,
    code_json: JSON.stringify({ tool: "task", input: {} }),
    created_at: new Date(1_700_000_000_000).toISOString(),
  };
}

describe("deriveTrace subagent label", () => {
  test.each([["Subagent \u2014 Review the diff"], ["Subagent: Review the diff"]])(
    "reads the title from %s",
    (label) => {
      expect(deriveTrace(subagentStep(label))).toMatchObject({
        verb: "Subagent",
        target: "Review the diff",
      });
    },
  );
});
