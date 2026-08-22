import { describe, expect, test } from "bun:test";
import type { Turn } from "./conversation";
import { terminalRunIdForThread } from "./terminal-run-state";
import type { ApiRun } from "./types";

function turn(status: Turn["status"], engineSessionId: string | null): Turn {
  const run = {
    id: "run-1",
    status,
    engine_session_id: engineSessionId,
  } as ApiRun;
  return {
    run,
    status,
  } as Turn;
}

describe("terminalRunIdForThread", () => {
  test("keeps Terminal idle when a failed root never established a provider session", () => {
    expect(terminalRunIdForThread([turn("failed", null)])).toBeUndefined();
  });

  test("retains the latest earlier thread sandbox after a pre-sandbox follow-up failure", () => {
    const root = turn("completed", "ses-root");
    root.run.id = "root";
    const failedFollowUp = turn("failed", null);
    failedFollowUp.run.id = "reply";

    expect(terminalRunIdForThread([root, failedFollowUp])).toBe("root");
  });

  test("selects the newest turn that owns a provider session", () => {
    const root = turn("completed", "ses-root");
    root.run.id = "root";
    const reply = turn("running", "ses-reply");
    reply.run.id = "reply";

    expect(terminalRunIdForThread([root, reply])).toBe("reply");
  });
});
