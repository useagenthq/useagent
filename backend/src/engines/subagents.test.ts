import { describe, expect, test } from "bun:test";
import { taskChildSessionId } from "./opencode-server";

// Child-session identity resolution for opencode task subagents. The SubtaskPart
// carries NO child-session field (its `sessionID` is the PARENT session the part
// lives on), so the REAL child id can only come from the matching `task`
// ToolPart: the pin-era (opencode 1.18.x) `state.metadata.sessionId`, else the
// `<task id="ses_…">` marker the task tool writes into its output. These
// fixtures mirror real 1.18.x storage rows (metadata carries sessionId,
// parentSessionId, model; output opens with the <task id> wrapper).
describe("taskChildSessionId (real child identity, never the parent)", () => {
  const OUTPUT =
    '<task id="ses_02de82b8dffexR6i5sz9slMOFd" state="completed">\n<task_result>\nPalantir (PLTR) closed at $162.66.\n</task_result>\n</task>';

  test("state.metadata.sessionId is authoritative when present", () => {
    expect(
      taskChildSessionId({
        output: OUTPUT,
        metadata: {
          sessionId: "ses_child_from_metadata",
          parentSessionId: "ses_parent",
          model: { modelID: "m", providerID: "p" },
        },
      }),
    ).toBe("ses_child_from_metadata");
  });

  test("falls back to the <task id> output marker when metadata is absent", () => {
    expect(taskChildSessionId({ output: OUTPUT })).toBe(
      "ses_02de82b8dffexR6i5sz9slMOFd",
    );
    expect(taskChildSessionId({ output: OUTPUT, metadata: {} })).toBe(
      "ses_02de82b8dffexR6i5sz9slMOFd",
    );
  });

  test("accepts the sessionID casing variant", () => {
    expect(
      taskChildSessionId({ output: "", metadata: { sessionID: "ses_variant" } }),
    ).toBe("ses_variant");
  });

  test("returns null when nothing names a child (never fabricates, never the parent)", () => {
    expect(taskChildSessionId({})).toBeNull();
    expect(taskChildSessionId({ output: "no marker here" })).toBeNull();
    expect(
      taskChildSessionId({ output: '<task id="not-a-session">' }),
    ).toBeNull(); // marker must be a real ses_* id
    expect(
      taskChildSessionId({ output: OUTPUT, metadata: { sessionId: 42 } }),
    ).toBe("ses_02de82b8dffexR6i5sz9slMOFd"); // non-string metadata falls through
  });
});
