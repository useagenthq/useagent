// Deterministic salience gate (memory self-improvement item 3). Pure — locks
// the v1 heuristic verdicts so a future model scorer can be diffed against this
// baseline. The DB-side "non-salient completions enqueue nothing" proof lives
// in test/finalize.test.ts.
import { describe, expect, test } from "bun:test";
import { assessCaptureSalience } from "./capture-salience";

const judge = (summary: string, prompt = "do the thing") =>
  assessCaptureSalience({ prompt, summary });

describe("assessCaptureSalience — skips", () => {
  test("empty / whitespace-only summaries", () => {
    expect(judge("")).toEqual({ salient: false, reason: "empty-summary" });
    expect(judge("   \n\t ")).toEqual({ salient: false, reason: "empty-summary" });
  });

  test("trivial one-liners and single tokens", () => {
    for (const s of ["OK", "ok.", "Done!", "sum", "Sure thing", "yes", "👍", "All done."]) {
      expect(judge(s).reason).toBe("trivial-acknowledgment");
    }
  });

  test("failed-run apologies", () => {
    expect(judge("I'm sorry, I couldn't access the repository you mentioned.").reason).toBe(
      "failure-apology",
    );
    expect(judge("Sorry, that task did not finish - the sandbox timed out.").reason).toBe(
      "failure-apology",
    );
    expect(judge("I apologize, but the credentials were rejected by the API.").reason).toBe(
      "failure-apology",
    );
    expect(
      judge("Unfortunately I was unable to reproduce the bug in the time available.").reason,
    ).toBe("failure-apology");
  });

  test("pure command output", () => {
    expect(judge("---- 200 404 500 ----\n42 1337").reason).toBe("command-output");
    expect(judge("$ git status\n$ git add -A\n$ git commit -m x").reason).toBe("command-output");
    expect(judge("+ set -e\n+ bun install\n+ bun test\ndone in 3s").reason).toBe("command-output");
  });
});

describe("assessCaptureSalience — keeps", () => {
  test("substantive summaries pass", () => {
    expect(
      judge("Fixed the retry loop: backoff now caps at 1h and dead-letters after 6 attempts."),
    ).toEqual({ salient: true, reason: "salient" });
    expect(judge("7 tools, edited 3 files, ran 3 commands").reason).toBe("salient");
  });

  test("mentioning an apology mid-text does not skip", () => {
    expect(
      judge("The bot replied with an apology because MEMORY_API_URL was unset; fixed by config."),
    ).toEqual({ salient: true, reason: "salient" });
  });

  test("'unfortunately' without an inability claim stays salient", () => {
    expect(
      judge("Unfortunately the legacy path is still needed; documented the constraint in AGENTS.md."),
    ).toEqual({ salient: true, reason: "salient" });
  });

  test("markdown structure is not mistaken for shell output", () => {
    expect(judge("# Findings\n> quoted context\n- fixed the parser\n- added 4 tests").reason).toBe(
      "salient",
    );
  });
});
