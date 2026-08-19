// Pure logic for verified-outcome capture evidence (memory self-improvement
// item 5): the user-correction heuristic and the deterministic rendered line.
// The DB collection path (steps/artifacts/parent lookup inside the finalize
// transaction) is proven in test/finalize.test.ts.
import { describe, expect, test } from "bun:test";
import { detectUserCorrection, renderCaptureEvidence } from "./capture-evidence";

describe("detectUserCorrection", () => {
  test("a thread root (no parent) is never a correction, whatever the wording", () => {
    expect(detectUserCorrection("fix this bug in the parser", null)).toBe(false);
    expect(detectUserCorrection("that's wrong, redo it", null)).toBe(false);
  });

  test("a reply to a FAILED parent is always a correction", () => {
    expect(detectUserCorrection("please continue", "failed")).toBe(true);
  });

  test("a reply with corrective language is a correction", () => {
    expect(detectUserCorrection("that's wrong, the config lives in env.ts", "completed")).toBe(true);
    expect(detectUserCorrection("not what I asked - I meant the frontend", "completed")).toBe(true);
    expect(detectUserCorrection("Actually, use the staging database", "completed")).toBe(true);
    expect(detectUserCorrection("you misunderstood: only the README", "completed")).toBe(true);
  });

  test("an ordinary follow-up reply is not a correction", () => {
    expect(detectUserCorrection("now add tests for the edge cases", "completed")).toBe(false);
    expect(detectUserCorrection("great, ship it to staging", "completed")).toBe(false);
  });
});

describe("renderCaptureEvidence", () => {
  test("renders the full outcome line deterministically", () => {
    const line = renderCaptureEvidence({
      source: "run",
      status: "completed",
      engine: "opencode",
      model: "claude-sonnet-5",
      durationMs: 42_000,
      toolCounts: { command: 4, file: 2 },
      artifacts: [{ name: "report.pdf", kind: "application/pdf" }],
      userCorrection: true,
    });
    expect(line).toBe(
      "[verified outcome] source=run status=completed engine=opencode model=claude-sonnet-5 duration=42s; " +
        "tools: command x4, file x2; artifacts: report.pdf (application/pdf); " +
        "user correction of the previous turn",
    );
  });

  test("omits absent sections (chat-shaped evidence) and sub-second durations stay in ms", () => {
    const line = renderCaptureEvidence({
      source: "chat",
      status: "completed",
      model: "anthropic/claude-sonnet-5",
      durationMs: 750,
    });
    expect(line).toBe(
      "[verified outcome] source=chat status=completed model=anthropic/claude-sonnet-5 duration=750ms",
    );
  });

  test("output is bounded even with pathological artifact names", () => {
    const line = renderCaptureEvidence({
      source: "run",
      status: "completed",
      artifacts: Array.from({ length: 10 }, (_, i) => ({
        name: `${"n".repeat(120)}-${i}`,
        kind: "k".repeat(60),
      })),
    });
    expect(line.length).toBeLessThanOrEqual(600);
  });
});
