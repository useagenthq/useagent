"use client";

// Lab showcase for the vendored T3 chat presentation grammar (components/t3-ui/,
// upstream commit 7c1bdd6e1, MIT). The mock data is OUR canonical timeline node
// shape (TimelineNode with real ApiStep code_json payloads), pushed through the
// t3-ui adapter - proving the ported pieces bind to the canonical lane, not to
// T3's client-runtime stores.

import { type TimelineNode } from "@/components/chat/timeline";
import { type ApiStep } from "@/components/chat/types";
import { workEntriesFromTimeline, workEntryFromTimelineNode } from "@/components/t3-ui/adapter";
import { T3BackgroundStatusPill } from "@/components/t3-ui/background-status-pill";
import { T3QueuedMessagePill } from "@/components/t3-ui/queued-message-pill";
import { T3SyncStatusPill } from "@/components/t3-ui/sync-status-pill";
import { T3WorkEntryRow } from "@/components/t3-ui/work-entry-row";
import { T3WorkGroup } from "@/components/t3-ui/work-group";
import { T3WorkedForFold } from "@/components/t3-ui/worked-for-fold";
import { T3WorkingIndicator } from "@/components/t3-ui/working-indicator";

// Mock steps get staggered timestamps (9s apart) so the worked-for fold derives
// a real duration from node timestamps: 5 nodes span t+9s..t+45s -> 36s.
const MOCK_T0 = Date.parse("2026-08-17T09:00:00Z");

let mockIdx = 0;
function toolNode(label: string, code: Record<string, unknown>, chip: string | null = null): TimelineNode {
  mockIdx += 1;
  const step: ApiStep = {
    id: `t3-mock-${mockIdx}`,
    run_id: "t3-mock-run",
    idx: mockIdx,
    kind: "command",
    label,
    chip,
    code_json: JSON.stringify(code),
    created_at: new Date(MOCK_T0 + mockIdx * 9000).toISOString(),
  };
  return { kind: "tool", key: step.id, step };
}

/** Mock canonical nodes shaped exactly like the canonical lane's reducer output. */
const MOCK_NODES: readonly TimelineNode[] = [
  toolNode("read", {
    tool: "read",
    input: { file_path: "frontend/app/page.tsx" },
    output: "export default function Page() {\n  return <Chat />;\n}",
  }),
  toolNode("edit", {
    tool: "edit",
    input: {
      file_path: "backend/src/provider-gateway/routes.ts",
      old_string: "const retries = 1;",
      new_string: "const retries = 3;\nconst backoffMs = 250;\nconst jitter = true;",
    },
    output: "Edited routes.ts",
  }),
  toolNode("bash", {
    tool: "bash",
    input: { command: "bun test provider-gateway" },
    output: "42 pass\n0 fail\nRan 42 tests across 3 files.",
    exit_code: 0,
  }),
  toolNode("bash", {
    tool: "bash",
    input: { command: "cat missing.txt" },
    output: "cat: missing.txt: No such file or directory",
    exit_code: 1,
    error: true,
  }),
  toolNode("create_issue", {
    tool: "mcp__github__create_issue",
    input: { name: "github", title: "Retry budget exhausted" },
    output: "Created issue #142",
  }),
];

const MOCK_REASONING: TimelineNode = {
  kind: "reasoning",
  key: "t3-mock-reasoning",
  text: "The retry test fails because the budget is shared across hedged requests. I should scope the budget per attempt chain, then re-run the focused suite.",
};

const MOCK_RUNNING: TimelineNode = toolNode("bash", {
  tool: "bash",
  input: { command: "bun run typecheck" },
});

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-10 border border-stroke-soft-200 bg-bg-white-0 p-3">
      <p className="text-mono-label mb-2 text-text-soft-400">{title}</p>
      {children}
    </div>
  );
}

export function T3TimelineShowcase() {
  const settledEntries = workEntriesFromTimeline(MOCK_NODES, false);
  const thinkingEntry = workEntryFromTimelineNode(MOCK_REASONING, "done");
  const runningEntry = workEntryFromTimelineNode(MOCK_RUNNING, "running");

  return (
    <div data-t3-ui="showcase" className="flex flex-col gap-4">
      <Panel title="work entry rows / canonical tool nodes">
        <div className="space-y-px">
          {settledEntries.map((entry) => (
            <T3WorkEntryRow key={entry.id} entry={entry} />
          ))}
        </div>
      </Panel>

      <Panel title="thinking disclosure + in-flight row">
        <div className="space-y-px">
          {thinkingEntry && <T3WorkEntryRow entry={thinkingEntry} turnSettled={false} />}
          {runningEntry && <T3WorkEntryRow entry={runningEntry} turnSettled={false} />}
        </div>
      </Panel>

      <Panel title="work group / overflow fold">
        <T3WorkGroup entries={settledEntries} />
      </Panel>

      <Panel title="worked-for fold / settled turn burst">
        <div className="space-y-3">
          <T3WorkedForFold nodes={MOCK_NODES} />
          <T3WorkedForFold nodes={MOCK_NODES} defaultExpanded />
        </div>
      </Panel>

      <Panel title="queued message pill / serial thread turns">
        <div className="space-y-2">
          <T3QueuedMessagePill position={1} onSendNow={() => {}} />
          <T3QueuedMessagePill position={2} />
        </div>
      </Panel>

      <Panel title="background status pill / live + monitoring + stopping">
        <div className="space-y-2">
          <T3BackgroundStatusPill
            label="Run in progress"
            startedAt="2026-08-17T09:00:00Z"
            onStop={() => {}}
          />
          <T3BackgroundStatusPill label="Monitoring in the background" onStop={() => {}} />
          <T3BackgroundStatusPill label="Run in progress" stopping onStop={() => {}} />
        </div>
      </Panel>

      <Panel title="working indicator">
        <T3WorkingIndicator createdAt="2026-08-17T09:00:00Z" stepLabel="bun run typecheck" />
      </Panel>

      <Panel title="sync status pill">
        <T3SyncStatusPill label="Catching up on this thread" />
      </Panel>
    </div>
  );
}
