"use client";

import {
  RiAddLine,
  RiChatHistoryLine,
  RiCheckLine,
  RiFileEditLine,
  RiFileList2Line,
  RiFlashlightLine,
  RiGitBranchLine,
  RiPlayLine,
  RiSearch2Line,
  RiSparkling2Line,
  RiTerminalBoxLine,
} from "@remixicon/react";
import Link from "next/link";
import * as React from "react";
import { ApprovalCard } from "@/components/ai/approval-card";
import { ContextCardStack } from "@/components/ai/context-card";
import { DiffTable } from "@/components/ai/diff-table";
import { FilterTable } from "@/components/ai/filter-table";
import { InsightCard } from "@/components/ai/insight-card";
import { LoadingState } from "@/components/ai/loading-state";
import { RecommendationCard } from "@/components/ai/recommendation-card";
import { RecordsTable } from "@/components/ai/records-table";
import { StreamingText } from "@/components/ai/streaming-text";
import { TaskRows } from "@/components/ai/task-rows";
import { Thinking } from "@/components/ai/thinking";
import { ToolChip } from "@/components/ai/tool-chips";
import { type OrbState, ThinkingOrb } from "@/components/base/thinking-orb";
import { AsteriskMark } from "@/components/foundations/brand/asterisk-mark";
import * as Badge from "@/components/ui/badge";
import * as Button from "@/components/ui/button";
import * as Input from "@/components/ui/input";
import * as Modal from "@/components/ui/modal";
import * as SegmentedControl from "@/components/ui/segmented-control";
import * as Select from "@/components/ui/select";
import * as StatusBadge from "@/components/ui/status-badge";
import * as Switch from "@/components/ui/switch";
import * as TabMenuHorizontal from "@/components/ui/tab-menu-horizontal";
import * as Table from "@/components/ui/table";
import { ARTIFACT_CAPABILITY_ROWS } from "./artifact-capability-matrix";
import { BeuiAgentShowcase } from "./beui-agent-showcase";
import { TimelineShowcase } from "./session-ui-showcase";

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4 border-t border-stroke-soft-200 py-8">
      <p className="text-mono-label text-text-soft-400">{label}</p>
      {children}
    </section>
  );
}

const runs = [
  { run: "Rate limiter", model: "sonnet", status: "completed" as const },
  { run: "Session store", model: "opus", status: "pending" as const },
  { run: "Cache warmer", model: "haiku", status: "failed" as const },
];

const statusColor: Record<
  (typeof runs)[number]["status"],
  { badge: "green" | "orange" | "red"; label: string }
> = {
  completed: { badge: "green", label: "Completed" },
  pending: { badge: "orange", label: "Running" },
  failed: { badge: "red", label: "Failed" },
};

export function ComponentLab() {
  const [model, setModel] = React.useState("sonnet");
  const [streamKey, setStreamKey] = React.useState(0);

  return (
    <main className="min-h-full bg-bg-white-0">
      {/* Halftone brand header */}
      <header className="relative overflow-hidden border-b border-stroke-soft-200">
        <div className="bg-halftone pointer-events-none absolute inset-0" aria-hidden />
        <div className="relative mx-auto flex max-w-4xl items-center gap-3 px-6 py-10">
          <AsteriskMark className="size-8 text-text-strong-950" />
          <div className="flex flex-col">
            <span className="text-label-lg text-text-strong-950">Component lab</span>
            <span className="text-mono-label text-text-soft-400">useAgent · AlignUI parts bin</span>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-4xl px-6">
        <div className="animate-ai-fade-up flex flex-col gap-3 py-10">
          <h1 className="text-title-h4 text-text-strong-950">The parts bin</h1>
          <p className="text-paragraph-md text-text-sub-600">
            Every vendored AlignUI primitive this app composes, wired to the useAgent brand layer.
            Toggle the theme from any page to confirm both render.
          </p>
          <Link
            href="/lab/session"
            className="inline-flex w-fit items-center gap-1.5 rounded-lg border border-stroke-soft-200 px-3 py-1.5 text-label-sm text-text-sub-600 transition-colors hover:bg-bg-weak-50 hover:text-text-strong-950"
          >
            <RiChatHistoryLine className="size-4" aria-hidden />
            Session sample - every timeline + chrome type in one conversation
          </Link>
        </div>

        <BeuiAgentShowcase />

        <Section label="T3 timeline grammar - vendored chat presentation (components/session-ui)">
          <TimelineShowcase />
        </Section>

        {/* Buttons */}
        <Section label="Button - variants, modes & sizes">
          <div className="flex flex-wrap items-center gap-3">
            <Button.Root variant="primary" mode="filled">
              <Button.Icon as={RiSparkling2Line} />
              Primary
            </Button.Root>
            <Button.Root variant="neutral" mode="filled">
              Neutral
            </Button.Root>
            <Button.Root variant="neutral" mode="stroke">
              Stroke
            </Button.Root>
            <Button.Root variant="primary" mode="lighter">
              Lighter
            </Button.Root>
            <Button.Root variant="error" mode="ghost">
              Ghost
            </Button.Root>
            <Button.Root variant="primary" mode="filled" size="xsmall">
              <Button.Icon as={RiAddLine} />
              New run
            </Button.Root>
          </div>
        </Section>

        {/* Badges */}
        <Section label="Badge - colors & variants">
          <div className="flex flex-wrap items-center gap-2">
            <Badge.Root variant="filled" color="green">
              Running
            </Badge.Root>
            <Badge.Root variant="light" color="blue">
              Queued
            </Badge.Root>
            <Badge.Root variant="lighter" color="orange">
              Review
            </Badge.Root>
            <Badge.Root variant="stroke" color="red">
              Failed
            </Badge.Root>
            <Badge.Root variant="light" color="purple">
              <Badge.Dot />
              Model
            </Badge.Root>
          </div>
        </Section>

        {/* Status badges */}
        <Section label="StatusBadge - run lifecycle">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge.Root variant="light" status="completed">
              <StatusBadge.Dot />
              Completed
            </StatusBadge.Root>
            <StatusBadge.Root variant="light" status="pending">
              <StatusBadge.Dot />
              Pending
            </StatusBadge.Root>
            <StatusBadge.Root variant="light" status="failed">
              <StatusBadge.Dot />
              Failed
            </StatusBadge.Root>
            <StatusBadge.Root variant="stroke" status="disabled">
              <StatusBadge.Dot />
              Idle
            </StatusBadge.Root>
          </div>
        </Section>

        {/* Input */}
        <Section label="Input - leading icon & error state">
          <div className="flex max-w-xl flex-col gap-3 sm:flex-row">
            <Input.Root className="flex-1">
              <Input.Wrapper>
                <Input.Icon as={RiSearch2Line} />
                <Input.Input placeholder="Search agents, runs, skills…" />
              </Input.Wrapper>
            </Input.Root>
            <Input.Root hasError className="flex-1">
              <Input.Wrapper>
                <Input.Input placeholder="Invalid input" defaultValue="oops" />
              </Input.Wrapper>
            </Input.Root>
          </div>
        </Section>

        {/* Select */}
        <Section label="Select - model picker">
          <div className="max-w-xs">
            <Select.Root value={model} onValueChange={setModel}>
              <Select.Trigger>
                <Select.Value placeholder="Choose a model" />
              </Select.Trigger>
              <Select.Content>
                <Select.Item value="sonnet">Claude Sonnet</Select.Item>
                <Select.Item value="opus">Claude Opus</Select.Item>
                <Select.Item value="haiku">Claude Haiku</Select.Item>
              </Select.Content>
            </Select.Root>
          </div>
        </Section>

        {/* Segmented control */}
        <Section label="SegmentedControl">
          <div className="max-w-sm">
            <SegmentedControl.Root defaultValue="all">
              <SegmentedControl.List>
                <SegmentedControl.Trigger value="all">All</SegmentedControl.Trigger>
                <SegmentedControl.Trigger value="active">Active</SegmentedControl.Trigger>
                <SegmentedControl.Trigger value="archived">Archived</SegmentedControl.Trigger>
              </SegmentedControl.List>
            </SegmentedControl.Root>
          </div>
        </Section>

        {/* Tabs */}
        <Section label="TabMenuHorizontal">
          <TabMenuHorizontal.Root defaultValue="overview">
            <TabMenuHorizontal.List>
              <TabMenuHorizontal.Trigger value="overview">
                <TabMenuHorizontal.Icon as={RiFlashlightLine} />
                Overview
              </TabMenuHorizontal.Trigger>
              <TabMenuHorizontal.Trigger value="runs">Runs</TabMenuHorizontal.Trigger>
              <TabMenuHorizontal.Trigger value="skills">Skills</TabMenuHorizontal.Trigger>
            </TabMenuHorizontal.List>
            <TabMenuHorizontal.Content value="overview" className="pt-4">
              <p className="text-paragraph-sm text-text-sub-600">
                Overview panel - the active-tab indicator animates underneath.
              </p>
            </TabMenuHorizontal.Content>
            <TabMenuHorizontal.Content value="runs" className="pt-4">
              <p className="text-paragraph-sm text-text-sub-600">Runs panel.</p>
            </TabMenuHorizontal.Content>
            <TabMenuHorizontal.Content value="skills" className="pt-4">
              <p className="text-paragraph-sm text-text-sub-600">Skills panel.</p>
            </TabMenuHorizontal.Content>
          </TabMenuHorizontal.Root>
        </Section>

        {/* Switch */}
        <Section label="Switch">
          <div className="flex items-center gap-3">
            <Switch.Root defaultChecked id="autopilot" />
            <label htmlFor="autopilot" className="text-label-sm text-text-strong-950">
              Autopilot mode
            </label>
          </div>
        </Section>

        {/* Table */}
        <Section label="Table - recent runs">
          <Table.Root>
            <Table.Header>
              <Table.Row>
                <Table.Head>Run</Table.Head>
                <Table.Head>Model</Table.Head>
                <Table.Head>Status</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {runs.map((row) => {
                const s = statusColor[row.status];
                return (
                  <Table.Row key={row.run}>
                    <Table.Cell className="text-label-sm text-text-strong-950">
                      {row.run}
                    </Table.Cell>
                    <Table.Cell className="[font-family:var(--font-mono)] text-paragraph-sm text-text-sub-600">
                      {row.model}
                    </Table.Cell>
                    <Table.Cell>
                      <Badge.Root variant="light" color={s.badge}>
                        {s.label}
                      </Badge.Root>
                    </Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table.Root>
        </Section>

        {/* Modal */}
        <Section label="Modal">
          <Modal.Root>
            <Modal.Trigger asChild>
              <Button.Root variant="neutral" mode="stroke">
                <Button.Icon as={RiPlayLine} />
                Open modal
              </Button.Root>
            </Modal.Trigger>
            <Modal.Content className="max-w-[440px]">
              <Modal.Header
                icon={RiSparkling2Line}
                title="Start a new run"
                description="Kick off an autonomous task on the selected repo."
              />
              <Modal.Body>
                <p className="text-paragraph-sm text-text-sub-600">
                  This is a live AlignUI modal - Escape, the backdrop, and the close button all
                  dismiss it.
                </p>
              </Modal.Body>
              <Modal.Footer>
                <Modal.Close asChild>
                  <Button.Root variant="neutral" mode="stroke" size="small">
                    Cancel
                  </Button.Root>
                </Modal.Close>
                <Button.Root variant="primary" mode="filled" size="small">
                  <Button.Icon as={RiCheckLine} />
                  Start run
                </Button.Root>
              </Modal.Footer>
            </Modal.Content>
          </Modal.Root>
        </Section>

        {/* Motion primitives */}
        <Section label="Brand motion primitives">
          <div className="flex flex-col gap-4">
            <p className="agent-progress-loading-text text-label-md">Thinking through the plan…</p>
            <p className="text-label-sm text-text-strong-950">
              Streaming output
              <span
                className="ai-caret ml-0.5 inline-block w-px bg-current align-middle"
                style={{ height: "1em" }}
              />
            </p>
            <div className="flex items-center gap-1.5">
              {[0, 1, 2, 3, 4].map((i) => (
                <span
                  key={i}
                  className="ai-loading-pixel size-1.5 rounded-full bg-primary-base"
                  style={{ animationDelay: `${i * 120}ms` }}
                />
              ))}
            </div>
          </div>
        </Section>

        {/* Thinking orb */}
        <Section label="Thinking orb - engine-driven agent loader">
          <p className="text-paragraph-sm text-text-sub-600">
            A canvas-rendered dotted thought-orb (vendored from chartden). Six states drive the
            “agent is thinking” moment; useAgent uses the <code>searching</code> preset for the
            session boot phase. Grayscale- by-depth, so it tracks the theme with no token mapping.
          </p>
          <div className="flex flex-wrap items-end gap-8">
            {(["working", "searching", "shaping"] as OrbState[]).map((state) => (
              <div key={state} className="flex flex-col items-center gap-2">
                <ThinkingOrb state={state} size={64} />
                <span className="text-mono-label text-text-soft-400 capitalize">{state}</span>
              </div>
            ))}
            <div className="flex items-center gap-2 self-center">
              <ThinkingOrb state="working" size={20} />
              <span className="text-paragraph-sm text-text-sub-600">Inline size (20px)</span>
            </div>
          </div>
        </Section>

        <Section label="Artifact workspace - shared capability contract">
          <p className="text-paragraph-sm text-text-sub-600">
            These rows come from the same browser-safe contract used by active session files, Live
            Artifacts, and the editor. Office and PDF edits use canonical companion state; this does
            not claim rich binary round-trip.
          </p>
          <div className="overflow-hidden rounded-xl border border-stroke-soft-200">
            <Table.Root>
              <Table.Header>
                <Table.Row>
                  <Table.Head>Workpiece</Table.Head>
                  <Table.Head>Edit state</Table.Head>
                  <Table.Head>Preview</Table.Head>
                  <Table.Head>Actions</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {ARTIFACT_CAPABILITY_ROWS.map((row) => (
                  <Table.Row key={row.kind}>
                    <Table.Cell>
                      <p className="text-label-sm text-text-strong-950">{row.label}</p>
                      <p className="font-mono text-paragraph-xs text-text-soft-400">
                        {row.defaultName}
                      </p>
                    </Table.Cell>
                    <Table.Cell className="font-mono text-paragraph-xs text-text-sub-600">
                      {row.edit ? `${row.edit.mode}:${row.edit.state}` : "unavailable"}
                    </Table.Cell>
                    <Table.Cell className="text-paragraph-xs text-text-sub-600">
                      {row.preview.inline ? row.preview.renderer : "attachment only"}
                    </Table.Cell>
                    <Table.Cell>
                      <div className="flex flex-wrap gap-1">
                        {row.actions.map((action) => (
                          <Badge.Root key={action} variant="lighter" color="gray">
                            {action}
                          </Badge.Root>
                        ))}
                      </div>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          </div>
        </Section>

        {/* ── AI component kit (components/ai) ─────────────────────────── */}
        <div className="animate-ai-fade-up flex flex-col gap-1 border-t border-stroke-soft-200 pt-10">
          <h2 className="text-title-h5 text-text-strong-950">AI kit</h2>
          <p className="text-paragraph-md text-text-sub-600">
            The <code>components/ai</code> primitives ported from beautiful-ui onto AlignUI tokens -
            streaming, agent activity, approvals, and tables.
          </p>
        </div>

        <Section label="AI kit · Streaming text">
          <StreamingText
            key={streamKey}
            text="Ported the AI component kit onto AlignUI tokens - streaming text, thinking disclosures, tool chips, approval cards and tables all read from the semantic scale, so they flip cleanly between light and the warm #20201f dark ladder."
            active
            sources={[
              { name: "AGENTS.md", url: "https://skynet-a.local/AGENTS.md" },
              { name: "beautiful-ui", url: "the component catalog" },
              { name: "AlignUI tokens", url: "https://alignui.com" },
            ]}
            onRegenerate={() => setStreamKey((k) => k + 1)}
          />
        </Section>

        <Section label="AI kit · Thinking disclosure">
          <Thinking label="Working - analysing repository" active open>
            <p className="text-paragraph-sm text-text-sub-600">
              Reading AGENTS.md and the tailwind token scale…
            </p>
            <p className="text-paragraph-sm text-text-sub-600">
              Mapping BoardUI status colors onto success / error / away.
            </p>
          </Thinking>
        </Section>

        <Section label="AI kit · Tool chips">
          <div className="flex flex-wrap gap-2">
            <ToolChip icon={RiTerminalBoxLine} label="bun run typecheck" state="running" />
            <ToolChip icon={RiGitBranchLine} label="git commit" state="done" />
            <ToolChip icon={RiFileEditLine} label="edit tool-step-row.tsx" count={3} state="done" />
            <ToolChip icon={RiSearch2Line} label="grep failed: no matches" state="error" />
          </div>
        </Section>

        <Section label="AI kit · Loading state">
          <LoadingState label="Loading runs" />
        </Section>

        <Section label="AI kit · Approval card">
          <ApprovalCard
            question="Allow network access to install dependencies?"
            options={[
              {
                label: "Approve for this run",
                detail: "Reach the npm registry until the run finishes",
              },
              { label: "Approve once", detail: "A single install, then revoke access" },
            ]}
            allowCustom
            onApprove={() => {}}
            onDeny={() => {}}
          />
        </Section>

        <Section label="AI kit · Context cards">
          <ContextCardStack
            label="Retrieved chunks"
            count={3}
            cards={[
              {
                title: "tailwind.config.ts",
                meta: "512 chars",
                icon: RiFileList2Line,
                body: "The AlignUI token scale bridged into Tailwind v4 - semantic bg / text / stroke families plus the state color ramps.",
              },
              {
                title: "app/globals.css",
                meta: "318 chars",
                body: "Motion utilities: .ai-caret, .ai-loading-pixel, .animate-ai-fade-up and the .agent-progress-loading-text shimmer.",
              },
              {
                title: "AGENTS.md",
                meta: "1.1k chars",
                body: "Namespace imports, the warm #20201f dark ladder, and the semantic-token-only rule.",
              },
            ]}
          />
        </Section>

        <Section label="AI kit · Recommendation card">
          <RecommendationCard
            title="Consolidate the two shimmer indicators"
            body="The conversation renders both a prompt-kit Loader and the ported Thinking disclosure. Keep the ported one so light/dark stays token-driven."
            confidence="high"
            onAccept={() => {}}
            onAlternatives={() => {}}
          />
        </Section>

        <Section label="AI kit · Insight cards">
          <div className="grid gap-3 sm:grid-cols-3">
            <InsightCard
              title="Runs / day"
              delta="+18%"
              tone="up"
              body="More runs kicked off since the new composer shipped."
              chart={[4, 6, 5, 8, 7, 11, 13]}
            />
            <InsightCard
              title="Avg duration"
              delta="-2.4s"
              tone="down"
              body="Faster median completion after the caching fix."
              chart={[12, 11, 11, 9, 8, 7, 6]}
            />
            <InsightCard
              title="Approvals"
              delta="0"
              tone="flat"
              body="No pending human approvals in the queue."
              chart={[3, 3, 3, 3, 3, 3, 3]}
            />
          </div>
        </Section>

        <Section label="AI kit · Diff table">
          <DiffTable
            columns={["File", "Symbol", "Change"]}
            rows={[
              { cells: ["tool-step-row.tsx", "ToolStepRow", "ToolChip"], status: "added" },
              { cells: ["conversation.tsx", "Loader", "removed"], status: "removed" },
              { cells: ["runs-list.tsx", "EmptyState", "LoadingState"], status: "changed" },
            ]}
          />
        </Section>

        <Section label="AI kit · Task rows">
          <TaskRows
            tasks={[
              {
                title: "Verified vendor records",
                status: "done",
                count: "12 suppliers",
                statusLabel: "Completed",
                substeps: [
                  { label: "Matched tax and contact IDs", value: "12/12" },
                  { label: "Flagged stale records", value: "0" },
                ],
              },
              {
                title: "Build reorder task list",
                status: "running",
                index: 2,
                count: "7 SKUs",
                substeps: [
                  { label: "Reading POS export", value: "3 files" },
                  { label: "Scoring stockout risk", value: "68%" },
                ],
              },
              {
                title: "Draft supplier emails",
                status: "pending",
                index: 3,
                count: "2 messages",
                substeps: [
                  { label: "Cone supplier follow-up", value: "draft" },
                  { label: "Pistachio reorder note", value: "draft" },
                ],
              },
            ]}
          />
        </Section>

        <Section label="AI kit · Filter table">
          <FilterTable
            statuses={[
              { key: "todo", label: "To do", tone: "warning" },
              { key: "progress", label: "In Progress", tone: "information" },
              { key: "done", label: "Completed", tone: "success" },
            ]}
            rows={[
              {
                name: "Restock mango sorbet",
                date: "Dec 03",
                statusKey: "todo",
                advisor: "Mango Moon Gelato",
              },
              {
                name: "Churn black sesame",
                date: "Sep 22",
                statusKey: "progress",
                advisor: "Kumo Creamery",
              },
              {
                name: "Print summer menu",
                date: "Jan 02",
                statusKey: "todo",
                advisor: "Coral Coast Sorbet",
              },
              {
                name: "Taste-test batch 42",
                date: "Nov 08",
                statusKey: "progress",
                advisor: "Maple Orbit",
              },
              {
                name: "Order waffle cones",
                date: "Apr 14",
                statusKey: "done",
                advisor: "Aurora Scoops",
              },
            ]}
          />
        </Section>

        <Section label="AI kit · Records table">
          <RecordsTable
            rows={[
              {
                company: "Andes Snow Creamery - Quito",
                categories: [
                  { label: "Gelato", color: "purple" },
                  { label: "Catering", color: "pink" },
                ],
                lastInteraction: "almost 2 years ago",
                strength: { label: "Very weak", tone: "critical" },
              },
              {
                company: "Kumo Creamery - Osaka",
                categories: [
                  { label: "Soft serve", color: "sky" },
                  { label: "Wholesale", color: "teal" },
                ],
                lastInteraction: "3 months ago",
                strength: { label: "Weak", tone: "weak" },
                links: [{ label: "kumo.jp", href: "https://example.com" }],
              },
              {
                company: "Aurora Scoops - Reykjavík",
                categories: [
                  { label: "Gelato", color: "purple" },
                  { label: "Events", color: "orange" },
                  { label: "Retail", color: "green" },
                ],
                lastInteraction: "2 weeks ago",
                strength: { label: "Strong", tone: "strong" },
                links: [{ label: "aurora.is", href: "https://example.com" }],
              },
              {
                company: "Maple Orbit - Montréal",
                categories: [{ label: "Sorbet", color: "red" }],
                lastInteraction: "6 months ago",
                strength: { label: "Medium", tone: "neutral" },
              },
            ]}
          />
        </Section>

        <div className="h-16" />
      </div>
    </main>
  );
}
