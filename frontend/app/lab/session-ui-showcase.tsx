"use client";

// Lab showcase for the vendored T3 chat presentation grammar (components/session-ui/,
// upstream commit 7c1bdd6e1, MIT). The mock data is OUR canonical timeline node
// shape (TimelineNode with real ApiStep code_json payloads), pushed through the
// session-ui adapter - proving the ported pieces bind to the canonical lane, not to
// T3's client-runtime stores.

import { type TimelineNode } from "@/components/chat/timeline";
import { type ApiStep } from "@/components/chat/types";
import {
  changedFilesFromTimeline,
  contextWindowFromChildUsage,
  workEntriesFromTimeline,
  workEntryFromTimelineNode,
} from "@/components/session-ui/adapter";
import { BackgroundStatusPill } from "@/components/session-ui/background-status-pill";
import { ChangedFilesCard } from "@/components/session-ui/changed-files-tree";
import {
  ContextWindowDetails,
  ContextWindowMeter,
} from "@/components/session-ui/context-window-meter";
import { ProposedPlanCard } from "@/components/session-ui/proposed-plan-card";
import { QueuedMessagePill } from "@/components/session-ui/queued-message-pill";
import { SyncStatusPill } from "@/components/session-ui/sync-status-pill";
import { WorkEntryRow } from "@/components/session-ui/work-entry-row";
import { WorkGroup } from "@/components/session-ui/work-group";
import { WorkedForFold } from "@/components/session-ui/worked-for-fold";
import { WorkingIndicator } from "@/components/session-ui/working-indicator";

// Mock steps get staggered timestamps (9s apart) so the worked-for fold derives
// a real duration from node timestamps: 5 nodes span t+9s..t+45s -> 36s.
const MOCK_T0 = Date.parse("2026-08-17T09:00:00Z");

let mockIdx = 0;
function toolNode(label: string, code: Record<string, unknown>, chip: string | null = null): TimelineNode {
  mockIdx += 1;
  const step: ApiStep = {
    id: `mock-${mockIdx}`,
    run_id: "mock-run",
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
  key: "mock-reasoning",
  text: "The retry test fails because the budget is shared across hedged requests. I should scope the budget per attempt chain, then re-run the focused suite.",
};

const MOCK_RUNNING: TimelineNode = toolNode("bash", {
  tool: "bash",
  input: { command: "bun run typecheck" },
});

// A settled turn's file mutations (edit/write tool steps + a durable file
// receipt), aggregated by the adapter into the changed-files card. The second
// routes.ts edit proves per-path merging (stats sum, first-touched order).
const MOCK_FILE_NODES: readonly TimelineNode[] = [
  toolNode("edit", {
    tool: "edit",
    input: {
      file_path: "backend/src/provider-gateway/routes.ts",
      old_string: "const retries = 1;",
      new_string: "const retries = 3;\nconst backoffMs = 250;\nconst jitter = true;",
    },
  }),
  toolNode("edit", {
    tool: "edit",
    input: {
      file_path: "backend/src/provider-gateway/retry.ts",
      old_string: "return attempt;\n// no budget",
      new_string: "const budget = budgetFor(attempt);\nreturn { attempt, budget };\n// scoped per chain",
    },
  }),
  toolNode("write", {
    tool: "write",
    input: {
      file_path: "frontend/components/session-ui/changed-files-tree.tsx",
      content: "export const ChangedFilesTree = () => null;",
    },
  }),
  toolNode("edit", {
    tool: "edit",
    input: {
      file_path: "backend/src/provider-gateway/routes.ts",
      old_string: "export { retry };\n// end",
      new_string: "export { retry, budgetFor };\nexport type { RetryBudget };\n// end",
    },
  }),
  {
    kind: "file",
    key: "mock-file-receipt",
    file: { path: "backend/src/knowledge/gateway/operation-registry.ts", changeType: "create" },
  },
];

const MOCK_CHANGED_FILES = changedFilesFromTimeline(MOCK_FILE_NODES);

// Context-window bindings: ChildUsage cumulative totals are the only token
// signal the frontend receives today; the 200k limit here is a mock prop.
const USAGE_STEADY = contextWindowFromChildUsage({ totalTokens: 61_400 }, 200_000);
const USAGE_OVERLOADED = contextWindowFromChildUsage({ totalTokens: 191_000 }, 200_000);
const USAGE_NO_LIMIT = contextWindowFromChildUsage({ totalTokens: 61_400 });

// A proposed plan the agent would submit for approval before execution. Long
// enough (>20 lines) to exercise the collapsed preview + Expand plan toggle.
// NOTE: no canonical event feeds this card yet (plan.updated is a checklist
// snapshot, approval.requested a tool-op approval); this is a prop-pure preview.
const MOCK_PLAN_MARKDOWN = [
  "# Scope retry budgets per attempt chain",
  "",
  "## Summary",
  "",
  "Hedged requests currently share one retry budget, so a slow primary starves its hedge.",
  "",
  "## Steps",
  "",
  "1. Introduce budgetFor(attempt) in backend/src/provider-gateway/retry.ts.",
  "2. Thread the scoped budget through routes.ts request hedging.",
  "3. Emit a budget-exhausted warning event instead of silently dropping.",
  "4. Backfill unit tests for the per-chain budget arithmetic.",
  "5. Re-run the focused provider-gateway suite.",
  "6. Verify no shared-budget exhaustion under the soak storm profile.",
  "7. Document the budget model in the provider-gateway README.",
  "8. Add a regression fixture for the hedged-slow-primary case.",
  "9. Sweep for callers still importing the old retry constant.",
  "10. Land behind the existing retry flag, default off.",
  "",
  "## Verification",
  "",
  "Run the provider-gateway suite and confirm zero shared-budget exhaustion.",
].join("\n");

const MOCK_SHORT_PLAN_MARKDOWN = [
  "# Rename the retry flag",
  "",
  "1. Rename PG_RETRY_V2 to PG_RETRY_BUDGETED.",
  "2. Update the two call sites and the env template.",
].join("\n");

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-10 border border-stroke-soft-200 bg-bg-white-0 p-3">
      <p className="text-mono-label mb-2 text-text-soft-400">{title}</p>
      {children}
    </div>
  );
}

export function TimelineShowcase() {
  const settledEntries = workEntriesFromTimeline(MOCK_NODES, false);
  const thinkingEntry = workEntryFromTimelineNode(MOCK_REASONING, "done");
  const runningEntry = workEntryFromTimelineNode(MOCK_RUNNING, "running");

  return (
    <div data-session-ui="showcase" className="flex flex-col gap-4">
      <Panel title="work entry rows / canonical tool nodes">
        <div className="space-y-px">
          {settledEntries.map((entry) => (
            <WorkEntryRow key={entry.id} entry={entry} />
          ))}
        </div>
      </Panel>

      <Panel title="thinking disclosure + in-flight row">
        <div className="space-y-px">
          {thinkingEntry && <WorkEntryRow entry={thinkingEntry} turnSettled={false} />}
          {runningEntry && <WorkEntryRow entry={runningEntry} turnSettled={false} />}
        </div>
      </Panel>

      <Panel title="work group / overflow fold">
        <WorkGroup entries={settledEntries} />
      </Panel>

      <Panel title="worked-for fold / settled turn burst">
        <div className="space-y-3">
          <WorkedForFold nodes={MOCK_NODES} />
          <WorkedForFold nodes={MOCK_NODES} defaultExpanded />
        </div>
      </Panel>

      <Panel title="proposed plan card / agent proposes, user approves before execution">
        <div className="space-y-3">
          <ProposedPlanCard planMarkdown={MOCK_PLAN_MARKDOWN} onImplement={() => {}} />
          <ProposedPlanCard planMarkdown={MOCK_SHORT_PLAN_MARKDOWN} onImplement={() => {}} />
        </div>
      </Panel>

      <Panel title="queued message pill / serial thread turns">
        <div className="space-y-2">
          <QueuedMessagePill position={1} onSendNow={() => {}} />
          <QueuedMessagePill position={2} />
        </div>
      </Panel>

      <Panel title="background status pill / live + monitoring + stopping">
        <div className="space-y-2">
          <BackgroundStatusPill
            label="Run in progress"
            startedAt="2026-08-17T09:00:00Z"
            onStop={() => {}}
          />
          <BackgroundStatusPill label="Monitoring in the background" onStop={() => {}} />
          <BackgroundStatusPill label="Run in progress" stopping onStop={() => {}} />
        </div>
      </Panel>

      <Panel title="working indicator">
        <WorkingIndicator createdAt="2026-08-17T09:00:00Z" stepLabel="bun run typecheck" />
      </Panel>

      <Panel title="sync status pill">
        <SyncStatusPill label="Catching up on this thread" />
      </Panel>

      <Panel title="changed files / per-turn aggregate tree + compact preview">
        <div className="space-y-3">
          <ChangedFilesCard files={MOCK_CHANGED_FILES} defaultExpanded onOpenFile={() => {}} />
          <ChangedFilesCard files={MOCK_CHANGED_FILES} onOpenFile={() => {}} />
        </div>
      </Panel>

      <Panel title="context window meter / steady + overloaded + no limit">
        <div className="flex items-center gap-2">
          <ContextWindowMeter usage={USAGE_STEADY} providerDisplayName="OpenCode" />
          <ContextWindowMeter usage={USAGE_OVERLOADED} providerDisplayName="OpenCode" />
          <ContextWindowMeter usage={USAGE_NO_LIMIT} />
        </div>
        <div className="mt-3 rounded-10 border border-stroke-soft-200 p-3">
          <ContextWindowDetails
            usage={{
              usedTokens: 132_000,
              maxTokens: 200_000,
              totalProcessedTokens: 1_240_000,
              compactsAutomatically: true,
            }}
            providerDisplayName="OpenCode"
          />
        </div>
      </Panel>
    </div>
  );
}
