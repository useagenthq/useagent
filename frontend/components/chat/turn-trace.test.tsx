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

const BOT = { durationMs: 192_000, defaultOpen: false };
const PLAIN = { durationMs: 192_000, defaultOpen: true };

const rows = (html: string) => html.match(/data-testid="trace-row"/g) ?? [];

describe("turn trace", () => {
  test("a bot thread starts with the trace folded and the reply as the block", () => {
    const html = renderToStaticMarkup(<Timeline nodes={NODES} live={false} trace={BOT} />);
    expect(html).toContain('data-testid="turn-trace"');
    expect(html).toContain("Thought for 3m 12s");
    expect(html).toContain(">2 tool calls<");
    expect(html).toContain('aria-expanded="false"');
    // The header is one pill: label, muted count, chevron. No star, no glyph
    // ahead of the text, no loader once settled.
    const header = html.split('data-testid="thinking-header"')[1]?.split("</button>")[0] ?? "";
    expect(header).toContain("rounded-full");
    expect(header).not.toContain("M12 2l2.4");
    expect(header).not.toContain("data-pattern");
    expect(header.indexOf("Thought for")).toBeLessThan(header.indexOf("<svg"));
    // The reply is the primary block, outside the trace.
    expect(html).toContain('data-testid="agent-answer"');
    expect(html).toContain("Here is today&#x27;s digest.");
    // Nothing behind the closed header reaches the DOM: no rows, no thought,
    // and never the raw payload.
    expect(rows(html)).toHaveLength(0);
    expect(html).not.toContain("Check the log first.");
    expect(html).not.toContain('{"result"');
  });

  test("a plain thread renders the same trace, open by default", () => {
    const html = renderToStaticMarkup(<Timeline nodes={NODES} live={false} trace={PLAIN} />);
    expect(html).toContain('data-testid="turn-trace"');
    expect(html).toContain('aria-expanded="true"');
    expect(rows(html)).toHaveLength(4);
    // One short line per step: a muted check, the family glyph, the label.
    expect(html).toContain('aria-label="Completed"');
    expect(html).toContain('data-family="memory"');
    expect(html).toContain('data-family="reasoning"');
    expect(html).toContain('data-family="shell"');
    expect(html).toContain(">Recalled memory<");
    expect(html).toContain(">4 items<");
    // Tool Chips grammar: the verb in text, the object in a mono chip.
    expect(html).toContain(">Thought<");
    expect(html).toContain(">Check the log first.<");
    expect(html).toContain(">Run<");
    expect(html).toContain('data-testid="trace-row-chip"');
    expect(html).toContain(">git log --since=yesterday<");
    expect(html).toContain(">digest<");
    // Payloads stay behind the row until it is opened: no reasoning prose
    // block, no output, never the raw payload, never the engine's tool title.
    expect(html).not.toContain('data-testid="trace-row-prose"');
    expect(html).not.toContain("b233c469 Merge");
    expect(html).not.toContain('{&quot;result&quot;');
    expect(html).not.toContain("Execute");
    // The old grammar is gone: no work groups, no marker rows, no "Thought" folds.
    expect(html).not.toContain('data-session-ui="work-group"');
    expect(html).not.toContain('data-testid="marker-row"');
    expect(html).not.toContain("settled-thought");
    // The reply is still the message.
    expect(html).toContain("Here is today&#x27;s digest.");
  });

  test("while live the header reads Thinking with the loader and the running step", () => {
    const html = renderToStaticMarkup(
      <Timeline nodes={NODES.slice(0, 3)} live trace={PLAIN} workingSince="2026-09-03T09:00:00Z" />,
    );
    expect(html).toContain('data-live="true"');
    expect(html).toContain("agent-progress-loading-text");
    expect(html).toContain(">Thinking<");
    // Live, the dots loader closes the pill in place of the chevron; still no star.
    const header = html.split('data-testid="thinking-header"')[1]?.split("</button>")[0] ?? "";
    expect(header).toContain('data-pattern="dots"');
    expect(header).not.toContain("M12 2l2.4");
    expect(header.indexOf("Thinking")).toBeLessThan(header.indexOf('data-pattern="dots"'));
    expect(html).toContain("Recalled memory");
    // The running row carries the pixel loader, not a check.
    expect(html).toContain('data-status="running"');
    expect(html).toContain('aria-label="Running"');
    expect(html).toContain('data-pattern="dots"');
    expect(html).not.toContain("Working, Execute");
    expect(html).not.toContain('{"result"');
    expect(html).not.toContain('data-session-ui="working-indicator"');
  });

  test("a failed step is an x and the settled header says so", () => {
    const failed = toolNode("s3", {
      tool: "execute",
      input: { command: "bun run typecheck" },
      output: "error TS2322",
      exit_code: 1,
    });
    const html = renderToStaticMarkup(<Timeline nodes={[failed]} live={false} trace={PLAIN} />);
    expect(html).toContain("1 tool call, 1 failed");
    expect(html).toContain('data-status="failed"');
    expect(html).toContain('aria-label="Failed"');
    expect(html).toContain(">bun run typecheck<");
    expect(html).toContain(">exit 1<");
  });

  test("a bot reply keeps fetched sources visible outside the closed trace", () => {
    const fetched = toolNode("s3", {
      tool: "webfetch",
      input: { url: "https://example.com/report" },
      output: "Report loaded",
    });
    const html = renderToStaticMarkup(
      <Timeline nodes={[fetched, NODES.at(-1)!]} live={false} trace={BOT} />,
    );
    expect(html).toContain('data-testid="turn-sources"');
    expect(html).toContain('href="https://example.com/report"');
    expect(html.match(/data-testid="turn-sources"/g)).toHaveLength(1);
  });

  test("a long trace keeps only its newest rows in the DOM until asked", () => {
    const many: TimelineNode[] = Array.from({ length: 30 }, (_, i) =>
      toolNode(`s${i}`, { tool: "execute", input: { command: `echo ${i}` }, output: String(i) }),
    );
    const html = renderToStaticMarkup(<Timeline nodes={many} live={false} trace={PLAIN} />);
    expect(rows(html)).toHaveLength(24);
    expect(html).toContain("Show 6 earlier steps");
    expect(html).toContain("echo 29");
    expect(html).not.toContain("echo 5<");
  });

  test("a turn that edited files closes its trace with the changed-files strip", () => {
    const edit = (id: string, file: string, oldText: string, newText: string) =>
      toolNode(id, {
        tool: "edit",
        input: { file_path: file, old_string: oldText, new_string: newText },
        output: `Edited ${file}`,
      });
    const nodes = [
      edit("s1", "backend/src/routes.ts", "a", "a\nb\nc"),
      edit("s2", "frontend/app/page.tsx", "x\ny\nz", "x"),
      edit("s3", "README.md", "1", "1\n2"),
      edit("s4", "docs/notes.md", "1", "1\n2\n3"),
      NODES.at(-1)!,
    ];
    const html = renderToStaticMarkup(<Timeline nodes={nodes} live={false} trace={PLAIN} />);
    const strip = html.split('data-testid="trace-changed-files"')[1] ?? "";
    expect(strip).toContain(">routes.ts<");
    expect(strip).toContain(">+3<");
    expect(strip).toContain(">-1<");
    expect(strip).toContain(">page.tsx<");
    expect(strip).toContain(">-3<");
    // Three chips, then the tail.
    expect(strip).not.toContain(">notes.md<");
    expect(strip).toContain("+1 more");
    // Edit rows read as "Edit" + the file chip + the line delta.
    expect(html).toContain('data-family="file-edit"');
    expect(html).toContain(">Edit<");
  });

  test("a durable file-only receipt feeds the changed-files strip", () => {
    const receipt: TimelineNode = {
      kind: "file",
      key: "file-receipt",
      file: { path: "src/generated-report.ts", changeType: "create" },
    };
    const html = renderToStaticMarkup(
      <Timeline nodes={[receipt, NODES.at(-1)!]} live={false} trace={PLAIN} />,
    );
    expect(html).toContain('data-testid="trace-changed-files"');
    expect(html).toContain("Changed 1 file");
    expect(html).toContain(">generated-report.ts<");
  });

  test("a turn without work or reasoning renders no header at all", () => {
    const html = renderToStaticMarkup(<Timeline nodes={[NODES.at(-1)!]} live={false} trace={PLAIN} />);
    expect(html).not.toContain('data-testid="turn-trace"');
    expect(html).toContain('data-testid="agent-answer"');
  });
});
