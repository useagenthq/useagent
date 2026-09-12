import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { TimelineNode } from "./timeline";
import { Timeline } from "./timeline-view";
import type { ApiStep } from "./types";

const RAW_MCP_RESULT = JSON.stringify({
  result: { content: [{ type: "text", text: "2 memories matched\n- ship on Fridays" }] },
});

function toolNode(id: string, code: Record<string, unknown>): TimelineNode {
  const step: ApiStep = {
    id,
    run_id: "run-1",
    idx: Number(id.slice(-1)),
    kind: "command",
    label: "Execute",
    chip: null,
    code_json: JSON.stringify(code),
    created_at: "2026-09-03T09:00:00Z",
  };
  return { kind: "tool", key: id, step };
}

const NODES: TimelineNode[] = [
  { kind: "marker", key: "m1", marker: { kind: "context", source: "memory", itemCount: 4, query: null } },
  { kind: "reasoning", key: "r1", text: "Check the log first." },
  toolNode("s1", {
    tool: "execute",
    input: { name: "memory_search", arguments: { query: "digest" } },
    output: RAW_MCP_RESULT,
  }),
  toolNode("s2", { tool: "execute", input: { command: "git log --since=yesterday" }, output: "b233c469 Merge" }),
  { kind: "text", key: "t1", text: "Here is today's digest." },
];

const BOT = { threadId: "thread-1", durationMs: 192_000 };

describe("bot thread turn", () => {
  test("a bot thread folds the work behind one line and shows the reply as the block", () => {
    const html = renderToStaticMarkup(<Timeline nodes={NODES} live={false} bot={BOT} />);
    expect(html).toContain('data-testid="bot-work-fold"');
    expect(html).toContain("Worked for 3m 12s, 4 steps");
    expect(html).toContain('aria-expanded="false"');
    // The reply is the primary block, outside the fold.
    expect(html).toContain('data-testid="bot-reply"');
    expect(html).toContain("Here is today&#x27;s digest.");
    // Nothing behind the closed fold reaches the DOM: no rows, no recall line,
    // no thought, and never the raw payload.
    expect(html).not.toContain('data-session-ui="work-group"');
    expect(html).not.toContain('data-testid="marker-row"');
    expect(html).not.toContain("settled-thought");
    expect(html).not.toContain("Check the log first.");
    expect(html).not.toContain('{"result"');
  });

  test("a plain thread keeps the flat timeline", () => {
    const html = renderToStaticMarkup(<Timeline nodes={NODES} live={false} />);
    expect(html).not.toContain('data-testid="bot-work-fold"');
    expect(html).not.toContain('data-testid="bot-reply"');
    expect(html).toContain('data-session-ui="work-group"');
    expect(html).toContain('data-testid="marker-row"');
    expect(html).toContain("Here is today&#x27;s digest.");
  });

  test("while live, the fold line names the latest step's human label", () => {
    const html = renderToStaticMarkup(
      <Timeline nodes={NODES.slice(0, 3)} live bot={BOT} workingSince="2026-09-03T09:00:00Z" />,
    );
    expect(html).toContain('data-testid="bot-work-fold"');
    expect(html).toContain('data-live="true"');
    expect(html).toContain("Working, Recalled memory");
    expect(html).not.toContain("Working, Execute");
    expect(html).not.toContain('{"result"');
    expect(html).not.toContain('data-testid="bot-reply"');
  });

  test("tool rows in the flat timeline never title themselves with the raw payload", () => {
    const recall = renderToStaticMarkup(<Timeline nodes={NODES.slice(2, 3)} live={false} />);
    expect(recall).toContain("Recalled memory");
    expect(recall).toContain("2 memories matched");
    expect(recall).not.toContain('{&quot;result&quot;');
    expect(recall).not.toContain("Execute");
    const shell = renderToStaticMarkup(<Timeline nodes={NODES.slice(3, 4)} live={false} />);
    expect(shell).toContain("git log --since=yesterday");
    expect(shell).toContain("b233c469 Merge");
    expect(shell).not.toContain("Execute");
  });

  test("a bot reply keeps fetched sources visible outside the closed work fold", () => {
    const fetched = toolNode("s3", {
      tool: "webfetch",
      input: { url: "https://example.com/report" },
      output: "Report loaded",
    });
    const html = renderToStaticMarkup(<Timeline nodes={[fetched, NODES.at(-1)!]} live={false} bot={BOT} />);
    expect(html).toContain('data-testid="turn-sources"');
    expect(html).toContain('href="https://example.com/report"');
    expect(html.match(/data-testid="turn-sources"/g)).toHaveLength(1);
  });
});
