import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  type AgentPanelRowModel,
  agentPanelActivityText,
  formatSubagentCostUsd,
  formatSubagentModelLabel,
  formatSubagentTokenCount,
  AgentPanelRow,
} from "./agent-panel-row";

const base: AgentPanelRowModel = {
  title: "Research checkout",
  role: null,
  engine: null,
  model: null,
  status: "running",
  statusLabel: "Running",
  progress: null,
  lastToolName: null,
  lastStepLabel: null,
  result: null,
  usage: null,
  elapsed: null,
};

describe("agentPanelActivityText", () => {
  test("live rows lead with streamed progress, then the last step label, then the tool line", () => {
    const busy: AgentPanelRowModel = {
      ...base,
      progress: "Scanning the checkout flow",
      lastStepLabel: "Ran bash: bun test",
      lastToolName: "bash",
    };
    expect(agentPanelActivityText(busy)).toBe("Scanning the checkout flow");
    expect(agentPanelActivityText({ ...busy, progress: null })).toBe("Ran bash: bun test");
    expect(agentPanelActivityText({ ...busy, progress: null, lastStepLabel: null })).toBe("▸ bash");
  });

  test("settled rows lead with the result preview; failed rows surface their error text", () => {
    expect(
      agentPanelActivityText({
        ...base,
        status: "completed",
        statusLabel: "Completed",
        progress: "old progress",
        result: "Found 3 issues in checkout",
      }),
    ).toBe("Found 3 issues in checkout");
    expect(
      agentPanelActivityText({
        ...base,
        status: "failed",
        statusLabel: "Failed",
        lastStepLabel: "Ran bash: bun test",
        result: "Timed out waiting for the sandbox",
      }),
    ).toBe("Timed out waiting for the sandbox");
  });

  test("returns null when nothing honest exists", () => {
    expect(agentPanelActivityText(base)).toBeNull();
  });
});

describe("formatSubagentTokenCount", () => {
  test("compacts counts the way the upstream fleet panel does", () => {
    expect(formatSubagentTokenCount(950)).toBe("950");
    expect(formatSubagentTokenCount(41200)).toBe("41.2k");
    expect(formatSubagentTokenCount(247000)).toBe("247k");
    expect(formatSubagentTokenCount(1_400_000)).toBe("1.4M");
  });
});

describe("formatSubagentCostUsd", () => {
  test("keeps ordinary and sub-cent child costs readable", () => {
    expect(formatSubagentCostUsd(0.031)).toBe("$0.03");
    expect(formatSubagentCostUsd(0.0042)).toBe("$0.0042");
  });
});

describe("formatSubagentModelLabel", () => {
  test("compacts model ids and appends effort", () => {
    expect(formatSubagentModelLabel("claude-sonnet-5[1m]", "high")).toBe("sonnet-5[1m] · high");
    expect(formatSubagentModelLabel("claude-opus-4-20250514", null)).toBe("opus-4");
    expect(formatSubagentModelLabel(null, "high")).toBeNull();
  });
});

describe("AgentPanelRow", () => {
  test("running row: pulsing dot, shimmering activity, open affordance, no fabricated tokens", () => {
    const html = renderToStaticMarkup(
      <AgentPanelRow
        agent={{ ...base, progress: "Reading files", elapsed: "34s" }}
        onOpen={() => {}}
      />,
    );
    expect(html).toContain('data-session-ui="agent-panel-row"');
    expect(html).toContain('data-testid="subagent-card"');
    expect(html).toContain("Open subagent: Research checkout");
    expect(html).toContain("animate-pulse");
    expect(html).toContain("agent-progress-loading-text");
    expect(html).toContain("Reading files");
    expect(html).toContain("34s");
    expect(html).not.toContain("tok");
  });

  test("settled row: result preview, token caption, model + role chip, completed check", () => {
    const html = renderToStaticMarkup(
      <AgentPanelRow
        agent={{
          ...base,
          status: "completed",
          statusLabel: "Completed",
          role: "reviewer",
          model: "claude-sonnet-5",
          result: "Found 3 issues in checkout",
          usage: { totalTokens: 41200, toolUses: 7, costUsd: 0.031 },
          elapsed: "1m 5s",
        }}
        onOpen={() => {}}
      />,
    );
    expect(html).toContain("Found 3 issues in checkout");
    expect(html).toContain("41.2k tok");
    expect(html).toContain("sonnet-5");
    expect(html).toContain("reviewer");
    expect(html).toContain("text-lime-600");
    expect(html).toContain("1m 5s");
    // A completed row leads with its result, never a redundant visible "Completed"
    // line - the word survives only once, in the sr-only status span.
    expect(html.split("Completed").length).toBe(2);
    expect(html).not.toContain("animate-pulse");
  });

  test("gateway child row links to its own session and shows engine + model", () => {
    const html = renderToStaticMarkup(
      <AgentPanelRow
        href="/session/child-run-1"
        agent={{
          ...base,
          title: "Get Google stock price",
          engine: "codex",
          model: "openai/gpt-5.6-sol",
          status: "completed",
          statusLabel: "Completed",
          result: "GOOGL is $344.82.",
        }}
      />,
    );
    expect(html).toContain('href="/session/child-run-1"');
    expect(html).toContain("Get Google stock price");
    expect(html).toContain("gpt-5.6-sol");
    expect(html).toContain("GOOGL is $344.82.");
  });

  test("failed row: error-toned activity; role chip hidden when it repeats the title", () => {
    const html = renderToStaticMarkup(
      <AgentPanelRow
        agent={{
          ...base,
          title: "Reviewer",
          role: "reviewer",
          status: "failed",
          statusLabel: "Failed",
          result: "Sandbox timed out",
        }}
        onOpen={() => {}}
      />,
    );
    expect(html).toContain("Sandbox timed out");
    expect(html).toContain("text-text-error-primary");
    expect(html.split("eviewer").length).toBe(3); // title + aria label only, no role chip
  });

  test("falls back to the status label when no activity exists", () => {
    const html = renderToStaticMarkup(
      <AgentPanelRow
        agent={{ ...base, status: "idle", statusLabel: "Idle · resumable" }}
        onOpen={() => {}}
      />,
    );
    expect(html).toContain("Idle · resumable");
  });
});
