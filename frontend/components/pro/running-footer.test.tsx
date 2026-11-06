import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RunningFooter } from "./running-footer";
import { deriveRunningStartedAt, type RunningStatus } from "./running-phase";
import type { ApiStep } from "@/components/chat/types";

const status: RunningStatus = {
  phase: "working",
  label: "Working",
  sentence: "bun run typecheck",
  toolCalls: 3,
  agentsRunning: 1,
  agentsDone: 2,
};

test("renders the phase chip, the current step, the elapsed time and the Stop control", () => {
  const startedAt = new Date(Date.now() - 65_000).toISOString();
  const html = renderToStaticMarkup(
    <RunningFooter status={status} model="Claude Sonnet 5" startedAt={startedAt} onStop={() => {}} />,
  );
  expect(html).toContain('data-session-ui="running-footer"');
  expect(html).toContain('role="status"');
  expect(html).toContain(">Working<");
  expect(html).toContain("bun run typecheck");
  expect(html).toContain("1m 5s");
  expect(html).toContain("font-mono");
  expect(html).toContain('aria-label="Stop this task"');
  // The chip is a real button with a caret that opens the details popover.
  expect(html).toContain('aria-label="Working. Task details"');
  expect(html).toContain("ai-loading-pixel");
});

test("stopping disables the control and says so; no elapsed without a start time", () => {
  const html = renderToStaticMarkup(<RunningFooter status={status} model="m" onStop={() => {}} stopping />);
  expect(html).toContain('aria-label="Stopping this task"');
  expect(html).toContain("disabled");
  expect(html).not.toContain("font-mono");
});

test("running elapsed excludes minutes in the queue and stays stable on reload", () => {
  const now = Date.now();
  const run = { created_at: new Date(now - 365_000).toISOString() };
  const start: ApiStep = {
    id: "start", run_id: "run", idx: 0, kind: "task", chip: "boot",
    label: "Preparing context and runtime", code_json: '{"phase":"preparing"}',
    created_at: new Date(now - 65_000).toISOString(),
  };
  const render = (turn: { run: typeof run; steps: ApiStep[] }) => renderToStaticMarkup(
    <RunningFooter status={status} model="m" startedAt={deriveRunningStartedAt(turn)} />,
  );
  expect(render({ run, steps: [] })).not.toContain("font-mono");
  const running = { run, steps: [start] };
  for (const snapshot of [running, JSON.parse(JSON.stringify(running))]) {
    const html = render(snapshot);
    expect(html).toContain("1m 5s");
    expect(html).not.toContain("6m 5s");
  }
});

test("a delegating phase names the agent in the chip", () => {
  const html = renderToStaticMarkup(
    <RunningFooter
      status={{ ...status, phase: "delegating", label: "Delegating Verify checkout", sentence: "Running the suite" }}
      model="m"
    />,
  );
  expect(html).toContain(">Delegating Verify checkout<");
  expect(html).toContain("Running the suite");
  expect(html).not.toContain("Stop this task");
});
