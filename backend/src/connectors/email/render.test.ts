import { describe, expect, it } from "bun:test";
import { renderEmail, type RenderEmailInput } from "./render";

const base: RenderEmailInput = {
  runId: "run-123",
  prompt: "build the thing",
  engine: "mock",
  status: "completed",
  summary: "3 tools, edited 3 files, ran 3 commands",
  durationMs: 12345,
  lines: [
    { type: "tool", text: "Cloning repository", toolKind: "execute" },
    { type: "thinking", text: "Analyzing codebase" },
    { type: "tool", text: "Editing file", toolKind: "edit" },
  ],
  assistantText: "All done.",
};

describe("renderEmail", () => {
  it("builds a subject with status + truncated prompt", () => {
    const { subject } = renderEmail(base);
    expect(subject).toBe("[skynet] Run completed — build the thing");
  });

  it("marks a failed run in the subject", () => {
    const { subject } = renderEmail({ ...base, status: "failed" });
    expect(subject).toContain("Run FAILED");
  });

  it("truncates a long prompt in the subject", () => {
    const long = "x".repeat(200);
    const { subject } = renderEmail({ ...base, prompt: long });
    // "[skynet] Run completed — " + <=60 chars
    expect(subject.length).toBeLessThanOrEqual("[skynet] Run completed — ".length + 60);
    expect(subject.endsWith("…")).toBe(true);
  });

  it("renders prompt, summary, engine, duration and the ordered step list", () => {
    const { text } = renderEmail(base);
    expect(text).toContain("Run run-123");
    expect(text).toContain("Status:   completed");
    expect(text).toContain("Engine:   mock");
    expect(text).toContain("Duration: 12.3s");
    expect(text).toContain("build the thing");
    expect(text).toContain("3 tools, edited 3 files, ran 3 commands");
    expect(text).toContain("Steps (3):");
    expect(text).toContain("• Cloning repository [execute]");
    expect(text).toContain("· Analyzing codebase");
    expect(text).toContain("• Editing file [edit]");
    expect(text).toContain("Assistant output:");
    expect(text).toContain("All done.");
  });

  it("shows (none) for a missing summary / assistant text and (no steps recorded)", () => {
    const { text } = renderEmail({
      ...base,
      summary: null,
      assistantText: "",
      lines: [],
    });
    expect(text).toContain("Summary:\n(none)");
    expect(text).toContain("Assistant output:\n(none)");
    expect(text).toContain("Steps (0):\n  (no steps recorded)");
  });

  it("reports unknown duration when durationMs is null", () => {
    const { text } = renderEmail({ ...base, durationMs: null });
    expect(text).toContain("Duration: unknown");
  });
});
