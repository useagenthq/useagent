// Synthetic fixtures preserve each engine's wire-shape differences without
// committing production prompts, identifiers, repositories, or tool output.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ApiRun } from "./types";
import { AgentAnswer, Timeline } from "./conversation";
import chat from "./fixtures/engine-runs/chat.json";
import claude from "./fixtures/engine-runs/claude.json";
import codex from "./fixtures/engine-runs/codex.json";
import opencode from "./fixtures/engine-runs/opencode.json";
import pi from "./fixtures/engine-runs/pi.json";
import type { TimelineNode } from "./timeline";
import { traceRowsFromWork, turnNodesFromSteps } from "./turn-trace-model";

interface EngineFixture {
  readonly id: string;
  readonly engine: ApiRun["engine"];
  readonly summary: string | null;
  readonly duration_ms: number | null;
  readonly reasoning?: string;
  readonly steps: ApiRun["steps"];
}

const FIXTURES: EngineFixture[] = [
  chat as EngineFixture,
  opencode as EngineFixture,
  claude as EngineFixture,
  codex as EngineFixture,
  pi as EngineFixture,
];

/** A settled turn exactly as TurnBlock's steps-only lane draws it: the trace
 *  (when there is work) and the run's summary as the reply. */
function renderSettled(fixture: EngineFixture): string {
  const nodes = turnNodesFromSteps(fixture.steps, false);
  return renderToStaticMarkup(
    <>
      <Timeline nodes={nodes} live={false} trace={{ durationMs: fixture.duration_ms, defaultOpen: true }} />
      {fixture.summary && <AgentAnswer summary={fixture.summary} />}
    </>,
  );
}

/** The same steps mid-run: boot rows included, the last node running. */
function renderLive(fixture: EngineFixture): string {
  const nodes: TimelineNode[] = [
    ...(fixture.reasoning ? [{ kind: "reasoning" as const, key: "r", text: fixture.reasoning }] : []),
    ...turnNodesFromSteps(fixture.steps, true),
  ];
  return renderToStaticMarkup(
    <Timeline nodes={nodes} live trace={{ durationMs: null, defaultOpen: true }} workingSince="2026-09-04T12:59:25Z" />,
  );
}

/** Text a person would see: tags stripped, entities decoded. */
function visibleText(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/** Markdown runes and whitespace normalized away, so a rendered reply can be
 *  matched against its source text. */
function plain(text: string): string {
  return text.replace(/[`*_#]/g, "").replace(/\s+/g, " ").trim();
}

const LEAKS = ["Execute", "mcp__", "mcp.", "useagent_", '{"result"', '{"formatted_output"', "formatted_output"];

describe.each(FIXTURES)("trace grammar on a synthetic $engine wire fixture", (fixture) => {
  test("settled: at most one header, verb-first rows, the reply outside the block", () => {
    const html = renderSettled(fixture);
    const text = visibleText(html);
    const headers = html.match(/data-testid="turn-trace"/g) ?? [];
    expect(headers.length).toBeLessThanOrEqual(1);
    // The reply is the message outside the block, never the engine's
    // 60-character preview of it (a `task` step label).
    expect(html).toContain('data-testid="agent-answer"');
    if (fixture.summary) expect(plain(text)).toContain(plain(fixture.summary).slice(0, 30));
    for (const step of fixture.steps) {
      if (step.kind === "task" && step.chip === "task") expect(html).not.toContain(step.label);
    }
    // No raw JSON, no engine tool title, no tool id anywhere a person reads.
    for (const leak of LEAKS) expect(text).not.toContain(leak);
    // Every row carries a verb-first label.
    const labels = [...html.matchAll(/data-testid="trace-row-label"[^>]*>([^<]*)</g)].map((m) => m[1]!);
    for (const label of labels) {
      expect(label.trim().length).toBeGreaterThan(0);
      expect(/^[A-Z]/.test(label)).toBe(true);
    }
    // Boot plumbing never survives into settled history.
    expect(text).not.toContain("Provisioning cloud sandbox");
    expect(text).not.toContain("Preparing context");
  });

  test("live: boot steps fold into one line and the header reads Thinking", () => {
    const html = renderLive(fixture);
    const text = visibleText(html);
    expect(html.match(/data-testid="turn-trace"/g)).toHaveLength(1);
    expect(html).toContain(">Thinking<");
    expect(text).not.toContain("Provisioning cloud sandbox");
    expect((html.match(/data-family="boot"/g) ?? []).length).toBeLessThanOrEqual(1);
    for (const leak of LEAKS) expect(text).not.toContain(leak);
  });
});

describe("what each engine's fixture proves", () => {
  test("chat: no work steps and no reasoning, so the answer is just the message", () => {
    const html = renderSettled(chat as EngineFixture);
    expect(html).not.toContain('data-testid="turn-trace"');
    expect(html).toContain('data-testid="agent-answer"');
    // Live, its context preparation is one boot line, never a Thinking row.
    const live = renderLive(chat as EngineFixture);
    expect(live).toContain(">Preparing chat context<");
    expect(live.match(/data-testid="trace-row"/g)).toHaveLength(1);
  });

  test("claude: the reply prose arrives as a task step and renders as the reply, not a row", () => {
    const html = renderSettled(claude as EngineFixture);
    expect(html).not.toContain('data-testid="turn-trace"');
    expect(visibleText(html)).toContain("The release checklist is ready");
    expect(html).not.toContain('data-testid="trace-row"');
  });

  test("opencode: underscore gateway tools read as playbook and memory calls", () => {
    const html = renderSettled(opencode as EngineFixture);
    const text = visibleText(html);
    expect(html.match(/data-testid="turn-trace"/g)).toHaveLength(1);
    expect(text).toContain("Searched the web");
    expect(text).toContain("Recalled memory");
    expect(text).toContain("Searched playbooks");
    expect(text).toContain("Activated playbook");
    expect(html).toContain('data-family="search"');
    expect(html).toContain('data-family="memory"');
    expect(html).toContain('data-family="playbook"');
    // The failed searches (provider unsupported) are honest x rows, not checks.
    expect(html).toContain('data-status="failed"');
  });

  test("codex: execute-bridged MCP calls, shell commands and reads all read as verbs", () => {
    const rows = traceRowsFromWork(turnNodesFromSteps((codex as EngineFixture).steps, false), false);
    const labels = new Set(rows.map((row) => row.label));
    expect(labels.has("Searched playbooks")).toBe(true);
    expect(labels.has("Activated playbook")).toBe(true);
    expect(labels.has("Run")).toBe(true);
    expect(labels.has("Read")).toBe(true);
    expect(labels.has("Search")).toBe(true);
    for (const row of rows) {
      expect(row.label).not.toContain("Execute");
      expect(row.label).not.toContain("mcp.");
      expect(row.chip?.text ?? "").not.toContain('{"');
    }
    // Shell rows chip the command line, read rows the file.
    expect(rows.find((row) => row.label === "Run")?.chip).toMatchObject({ mono: true });
    expect(rows.find((row) => row.label === "Read")?.chip?.text).toBe("README.md");
    // Tool payloads never surface in a row.
    const html = renderSettled(codex as EngineFixture);
    expect(html).not.toContain("Synthetic project overview");
    expect(html.match(/data-testid="turn-trace"/g)).toHaveLength(1);
  });

  test("pi: its projected steps produce a file row and a command row with the changed file", () => {
    const html = renderSettled(pi as EngineFixture);
    expect(html.match(/data-testid="turn-trace"/g)).toHaveLength(1);
    expect(html).toContain('data-family="file-write"');
    expect(html).toContain(">Write<");
    expect(html).toContain(">notes.txt<");
    expect(html).toContain('data-family="shell"');
    expect(html).toContain(">cat /workspace/notes.txt<");
    expect(html).toContain('data-testid="trace-changed-files"');
    // Live, the thinking delta folds into its own row ahead of the tools.
    const live = renderLive(pi as EngineFixture);
    expect(live).toContain('data-family="reasoning"');
    expect(live).toContain(">The request needs one small text file and a verification read.<");
    expect(live).not.toContain('data-testid="trace-row-prose"');
  });
});
