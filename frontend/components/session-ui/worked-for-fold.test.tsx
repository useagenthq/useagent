import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { type TimelineNode } from "@/components/chat/timeline";
import { type ApiStep } from "@/components/chat/types";
import * as Tooltip from "@/components/ui/tooltip";
import { WorkedForFold, workedForDuration, workedForLabel } from "./worked-for-fold";

function toolNode(id: string, command: string, createdAt: string): TimelineNode {
  const step: ApiStep = {
    id,
    run_id: "fold-run",
    idx: Number(id.slice(-1)),
    kind: "command",
    label: "bash",
    chip: null,
    code_json: JSON.stringify({ tool: "bash", input: { command }, output: "ok", exit_code: 0 }),
    created_at: createdAt,
  };
  return { kind: "tool", key: step.id, step };
}

const REASONING: TimelineNode = { kind: "reasoning", key: "fold-r1", text: "Considering the fix." };

const BURST: readonly TimelineNode[] = [
  toolNode("fold-1", "bun test retry", "2026-08-17T09:00:00Z"),
  REASONING,
  toolNode("fold-2", "bun run typecheck", "2026-08-17T09:00:09Z"),
];

test("workedForDuration spans the tool nodes' own timestamps", () => {
  expect(workedForDuration(BURST)).toBe("9s");
});

test("workedForDuration is null without timestamped tool nodes", () => {
  expect(workedForDuration([REASONING])).toBeNull();
});

test("workedForLabel falls back to the bare upstream label", () => {
  expect(workedForLabel("9s")).toBe("Worked for 9s");
  expect(workedForLabel(null)).toBe("Worked");
});

test("collapsed fold shows only the duration header", () => {
  const html = renderToStaticMarkup(
    <Tooltip.Provider>
      <WorkedForFold nodes={BURST} />
    </Tooltip.Provider>,
  );
  expect(html).toContain('data-session-ui="worked-for-fold"');
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain("Worked for 9s");
  expect(html).not.toContain('data-session-ui="work-entry-row"');
});

test("expanded fold renders the burst as T3 work rows", () => {
  const html = renderToStaticMarkup(
    <Tooltip.Provider>
      <WorkedForFold nodes={BURST} defaultExpanded />
    </Tooltip.Provider>,
  );
  expect(html).toContain('aria-expanded="true"');
  const rows = html.match(/data-session-ui="work-entry-row"/g) ?? [];
  expect(rows.length).toBe(3); // two tools + the thinking row
  expect(html).toContain("bun test retry");
});

test("renders nothing for an empty burst", () => {
  expect(renderToStaticMarkup(<WorkedForFold nodes={[]} />)).toBe("");
});
