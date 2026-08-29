/**
 * Pure card-builder tests: no I/O, no Slack, fixtures only. Asserts the Block Kit
 * SHAPE (header/status/model/repo/+N/button-url) and the length-cap truncation so
 * a long title or answer can never get the whole card rejected as invalid_blocks.
 */
import { describe, expect, test } from "bun:test";
import type { RepoRef } from "../github/repo-ref";
import {
  buildRunCard,
  deriveTitle,
  phaseForStatus,
  sessionUrl,
  type RunCardInput,
} from "./card";

const ref = (repo: string, branch: string | null = null): RepoRef => ({ repo, branch });

/** Find the first section/context/actions block; typed loosely for assertions. */
function firstOfType(blocks: unknown[], type: string): any {
  return (blocks as any[]).find((b) => b?.type === type);
}
function allOfType(blocks: unknown[], type: string): any[] {
  return (blocks as any[]).filter((b) => b?.type === type);
}

const base: RunCardInput = {
  title: "Add a dark mode toggle",
  phase: "queued",
  model: "claude-opus-5",
  repoSpecs: [],
  webUrl: "https://app.example.com/session/thread-1",
};

describe("sessionUrl", () => {
  test("joins origin + /session/ + threadId, trimming a trailing slash", () => {
    expect(sessionUrl("https://app.example.com", "t-9")).toBe("https://app.example.com/session/t-9");
    expect(sessionUrl("https://app.example.com/", "t-9")).toBe("https://app.example.com/session/t-9");
  });
});

describe("deriveTitle", () => {
  test("takes the first non-empty line", () => {
    expect(deriveTitle("\n\n  Build the thing  \nand more")).toBe("Build the thing");
  });
  test("truncates a very long single line and adds an ellipsis", () => {
    const title = deriveTitle("x".repeat(500));
    expect(title.length).toBeLessThanOrEqual(148);
    expect(title.endsWith("…")).toBe(true);
  });
  test("falls back to 'Run' for an empty prompt", () => {
    expect(deriveTitle("   \n  ")).toBe("Run");
  });
});

describe("phaseForStatus", () => {
  test("maps run statuses onto card phases", () => {
    expect(phaseForStatus("completed")).toBe("completed");
    expect(phaseForStatus("failed")).toBe("failed");
    expect(phaseForStatus("running")).toBe("running");
    expect(phaseForStatus("queued")).toBe("queued");
  });
});

describe("buildRunCard shape", () => {
  test("header carries the status emoji + label + title", () => {
    const { blocks } = buildRunCard(base);
    const header = firstOfType(blocks, "section");
    expect(header.text.type).toBe("mrkdwn");
    expect(header.text.text).toContain(":hourglass_flowing_sand:");
    expect(header.text.text).toContain("Queued");
    expect(header.text.text).toContain("Add a dark mode toggle");
  });

  test("running phase shows the gear + a working step context line", () => {
    const { blocks } = buildRunCard({ ...base, phase: "running", workingStep: "editing app.tsx" });
    const header = firstOfType(blocks, "section");
    expect(header.text.text).toContain(":gear:");
    const contexts = allOfType(blocks, "context");
    // model row + working row.
    expect(contexts.length).toBe(2);
    expect(contexts[1].elements[0].text).toContain("working: editing app.tsx");
  });

  test("context row carries the model", () => {
    const { blocks } = buildRunCard(base);
    const context = firstOfType(blocks, "context");
    expect(context.elements[0].text).toContain("claude-opus-5");
  });

  test("one repo renders 'owner/repo · branch' (no +N)", () => {
    const { blocks } = buildRunCard({ ...base, repoSpecs: [ref("loop/backend", "main")] });
    const context = firstOfType(blocks, "context");
    expect(context.elements[0].text).toContain("loop/backend · main");
    expect(context.elements[0].text).not.toContain("more");
  });

  test("multiple repos render the first + '+N more'", () => {
    const { blocks } = buildRunCard({
      ...base,
      repoSpecs: [ref("loop/backend"), ref("loop/frontend"), ref("loop/infra", "deploy")],
    });
    const context = firstOfType(blocks, "context");
    expect(context.elements[0].text).toContain("loop/backend");
    expect(context.elements[0].text).toContain("+2 more");
  });

  test("no repos: the context row omits the repo segment", () => {
    const { blocks } = buildRunCard(base);
    const context = firstOfType(blocks, "context");
    expect(context.elements[0].text).not.toContain("Repo:");
  });

  test("the actions block has an 'Open in useAgent' url button", () => {
    const { blocks } = buildRunCard(base);
    const actions = firstOfType(blocks, "actions");
    const button = actions.elements[0];
    expect(button.type).toBe("button");
    expect(button.text.text).toBe("Open in useAgent");
    expect(button.action_id).toBe("open_in_useagent");
    expect(button.url).toBe("https://app.example.com/session/thread-1");
  });

  test("a non-terminal card carries NO answer section", () => {
    const { blocks } = buildRunCard(base);
    // Only header (section) + context + actions; no divider/answer section.
    expect(allOfType(blocks, "divider")).toHaveLength(0);
    expect(allOfType(blocks, "section")).toHaveLength(1);
  });

  test("a completed card appends the answer as an mrkdwn section (markdown converted)", () => {
    const { blocks, text } = buildRunCard({
      ...base,
      phase: "completed",
      answer: "**Done** with the toggle",
    });
    expect(allOfType(blocks, "divider")).toHaveLength(1);
    const sections = allOfType(blocks, "section");
    const answer = sections[sections.length - 1];
    // toSlackMrkdwn converts **bold** -> *bold*.
    expect(answer.text.text).toContain("*Done*");
    // The fallback text mirrors the answer.
    expect(text).toContain("*Done*");
  });

  test("a completed card with no answer says 'Done.'", () => {
    const { blocks, text } = buildRunCard({ ...base, phase: "completed" });
    const sections = allOfType(blocks, "section");
    expect(sections[sections.length - 1].text.text).toBe("Done.");
    expect(text).toBe("Done.");
  });

  test("a failed card warns with the reason", () => {
    const { blocks, text } = buildRunCard({ ...base, phase: "failed", answer: "boom" });
    const sections = allOfType(blocks, "section");
    expect(sections[sections.length - 1].text.text).toContain(":warning: Run failed: boom");
    expect(text).toContain(":warning: Run failed: boom");
  });

  test("a very long answer is truncated under the section cap", () => {
    const { blocks } = buildRunCard({ ...base, phase: "completed", answer: "z".repeat(10_000) });
    const sections = allOfType(blocks, "section");
    const answer = sections[sections.length - 1];
    expect(answer.text.text.length).toBeLessThanOrEqual(2900);
    expect(answer.text.text.endsWith("…")).toBe(true);
  });

  test("a title with mrkdwn control chars cannot break the header layout", () => {
    const { blocks } = buildRunCard({ ...base, title: "fix *bold* and _under_" });
    const header = firstOfType(blocks, "section");
    // The chrome escapes the raw control chars (zero-width-joined), so the header
    // does not contain a naked "*bold*" that would render as formatting.
    expect(header.text.text).not.toContain("*bold*");
  });

  test("the header title is a bold mrkdwn link to the web session", () => {
    const { blocks } = buildRunCard(base);
    const header = firstOfType(blocks, "section");
    expect(header.text.text).toContain("<https://app.example.com/session/thread-1|Add a dark mode toggle>");
    // Bold wraps the whole header line (emoji + label + linked title).
    expect(header.text.text.startsWith("*")).toBe(true);
    expect(header.text.text.endsWith("*")).toBe(true);
  });

  test("link-breaking chars in a title cannot escape the link label", () => {
    const { blocks } = buildRunCard({ ...base, title: "a>b|c" });
    const header = firstOfType(blocks, "section");
    expect(header.text.text).toContain("<https://app.example.com/session/thread-1|a b c>");
  });

  test("omitAnswer keeps a terminal card chrome-only (the stream body has the reply)", () => {
    const { blocks } = buildRunCard({ ...base, phase: "completed", answer: "the reply", omitAnswer: true });
    expect(allOfType(blocks, "divider")).toHaveLength(0);
    expect(allOfType(blocks, "section")).toHaveLength(1); // header only
    const actions = firstOfType(blocks, "actions");
    expect(actions.elements[0].text.text).toBe("Open in useAgent");
  });

  test("the fallback text for a non-terminal card summarizes status + title + model", () => {
    const { text } = buildRunCard({ ...base, phase: "queued", repoSpecs: [ref("a/b")] });
    expect(text).toContain("Queued: Add a dark mode toggle");
    expect(text).toContain("claude-opus-5");
    expect(text).toContain("a/b");
    expect(text).not.toContain("—"); // no em dashes in user-visible strings
  });
});
