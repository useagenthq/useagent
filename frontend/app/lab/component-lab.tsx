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
import { Badge as CounterBadge } from "@/components/base/badges/badge";
import { Chip } from "@/components/base/badges/chip";
import { StatusDot } from "@/components/base/badges/status-dot";
import { Button } from "@/components/base/buttons/button";
import { IconButton } from "@/components/base/buttons/icon-button";
import { Input } from "@/components/base/input/input";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/base/segmented-control/segmented-control";
import { Select, SelectItem } from "@/components/base/select/select";
import { Switch } from "@/components/base/switch/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow,
} from "@/components/base/table/table";
import { Tab, TabList, TabPanel, Tabs } from "@/components/base/tabs/tabs";
import { type OrbState, ThinkingOrb } from "@/components/base/thinking-orb";
import { AsteriskMark } from "@/components/foundations/brand/asterisk-mark";
import * as Modal from "@/components/base/modal/modal";
import { ARTIFACT_CAPABILITY_ROWS } from "./artifact-capability-matrix";
import { BeautifulUiExtras } from "./beautiful-ui-extras";
import { BeuiAgentShowcase } from "./beui-agent-showcase";
import { TimelineShowcase } from "./session-ui-showcase";

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4 border-t border-border-button-default py-8">
      <p className="text-mono-label text-text-tertiary">{label}</p>
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
  { chip: "lime" | "yellow" | "rose"; label: string }
> = {
  completed: { chip: "lime", label: "Completed" },
  pending: { chip: "yellow", label: "Running" },
  failed: { chip: "rose", label: "Failed" },
};

export function ComponentLab() {
  const [model, setModel] = React.useState("sonnet");
  const [streamKey, setStreamKey] = React.useState(0);

  return (
    <main className="min-h-full bg-background-primary-default">
      {/* Halftone brand header */}
      <header className="relative overflow-hidden border-b border-border-button-default">
        <div className="bg-halftone pointer-events-none absolute inset-0" aria-hidden />
        <div className="relative mx-auto flex max-w-4xl items-center gap-3 px-6 py-10">
          <AsteriskMark className="size-8 text-text-primary" />
          <div className="flex flex-col">
            <span className="text-headline-medium text-text-primary">Component lab</span>
            <span className="text-mono-label text-text-tertiary">useAgent · Base kit parts bin</span>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-4xl px-6">
        <div className="animate-ai-fade-up flex flex-col gap-3 py-10">
          <h1 className="text-title-1-semibold text-text-primary">Base kit parts bin</h1>
          <p className="text-body-regular text-text-secondary">
            Every native base-kit primitive this app composes, wired to the useAgent brand layer.
            Toggle the theme from any page to confirm both render.
          </p>
          <Link
            href="/lab/session"
            className="inline-flex w-fit items-center gap-1.5 rounded-lg border border-border-button-default px-3 py-1.5 text-body-2-medium text-text-secondary transition-colors hover:bg-background-primary-hover hover:text-text-primary"
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
        <Section label="Button - variants & sizes">
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" leadingIcon={RiSparkling2Line}>
              Primary
            </Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="danger">Danger</Button>
            <Button variant="secondary" size="small">
              Small
            </Button>
            <Button variant="primary" size="xs" leadingIcon={RiAddLine}>
              New run
            </Button>
            <IconButton icon={RiAddLine} size="small" aria-label="New run" />
          </div>
        </Section>

        {/* Chips + counter badges */}
        <Section label="Chip & Badge - status colors, emphasis levels, counters">
          <div className="flex flex-wrap items-center gap-2">
            <Chip color="lime">Running</Chip>
            <Chip color="cyan">Queued</Chip>
            <Chip color="yellow">Review</Chip>
            <Chip color="rose">Failed</Chip>
            <Chip variant="subtle" color="purple">
              Model
            </Chip>
            <Chip variant="caption" color="gray">
              Role tag
            </Chip>
            <Chip variant="caption" color="soft">
              Soft
            </Chip>
            <CounterBadge color="primary">12</CounterBadge>
            <CounterBadge color="neutral">4</CounterBadge>
          </div>
        </Section>

        {/* Status dots */}
        <Section label="StatusDot - run lifecycle">
          <div className="flex flex-wrap items-center gap-5">
            <span className="inline-flex items-center gap-1.5 text-body-2-medium text-text-primary">
              <StatusDot color="green" />
              Completed
            </span>
            <span className="inline-flex items-center gap-1.5 text-body-2-medium text-text-primary">
              <StatusDot color="yellow" />
              Pending
            </span>
            <span className="inline-flex items-center gap-1.5 text-body-2-medium text-text-primary">
              <StatusDot color="indigo" />
              Queued
            </span>
            <Chip variant="caption" color="rose">
              Failed
            </Chip>
          </div>
        </Section>

        {/* Input */}
        <Section label="Input - leading icon & error state">
          <div className="flex max-w-xl flex-col gap-3 sm:flex-row">
            <Input
              className="flex-1"
              leadingIcon={RiSearch2Line}
              placeholder="Search agents, runs, skills…"
            />
            <Input
              className="flex-1"
              isInvalid
              placeholder="Invalid input"
              defaultValue="oops"
            />
          </div>
        </Section>

        {/* Select */}
        <Section label="Select - model picker">
          <div className="max-w-xs">
            <Select
              aria-label="Choose a model"
              placeholder="Choose a model"
              selectedKey={model}
              onSelectionChange={(key) => {
                if (key != null) setModel(String(key));
              }}
            >
              <SelectItem id="sonnet">Claude Sonnet</SelectItem>
              <SelectItem id="opus">Claude Opus</SelectItem>
              <SelectItem id="haiku">Claude Haiku</SelectItem>
            </Select>
          </div>
        </Section>

        {/* Segmented control */}
        <Section label="SegmentedControl">
          <div className="max-w-sm">
            <SegmentedControl aria-label="Run filter" defaultSelectedKeys={["all"]}>
              <SegmentedControlItem id="all">All</SegmentedControlItem>
              <SegmentedControlItem id="active">Active</SegmentedControlItem>
              <SegmentedControlItem id="archived">Archived</SegmentedControlItem>
            </SegmentedControl>
          </div>
        </Section>

        {/* Tabs */}
        <Section label="Tabs - underline">
          <Tabs defaultSelectedKey="overview">
            <TabList aria-label="Lab sections">
              <Tab id="overview" icon={RiFlashlightLine}>
                Overview
              </Tab>
              <Tab id="runs">Runs</Tab>
              <Tab id="skills">Skills</Tab>
            </TabList>
            <TabPanel id="overview">
              <p className="text-body-2-regular text-text-secondary">
                Overview panel - the active-tab underline animates between tabs.
              </p>
            </TabPanel>
            <TabPanel id="runs">
              <p className="text-body-2-regular text-text-secondary">Runs panel.</p>
            </TabPanel>
            <TabPanel id="skills">
              <p className="text-body-2-regular text-text-secondary">Skills panel.</p>
            </TabPanel>
          </Tabs>
        </Section>

        {/* Switch */}
        <Section label="Switch">
          <Switch defaultSelected>Autopilot mode</Switch>
        </Section>

        {/* Table */}
        <Section label="Table - recent runs">
          <Table aria-label="Recent runs">
            <TableHeader>
              <TableColumn isRowHeader>Run</TableColumn>
              <TableColumn>Model</TableColumn>
              <TableColumn>Status</TableColumn>
            </TableHeader>
            <TableBody>
              {runs.map((row) => {
                const s = statusColor[row.status];
                return (
                  <TableRow key={row.run}>
                    <TableCell className="text-body-2-medium text-text-primary">
                      {row.run}
                    </TableCell>
                    <TableCell className="font-mono text-body-2-regular text-text-secondary">
                      {row.model}
                    </TableCell>
                    <TableCell>
                      <Chip variant="caption" color={s.chip}>
                        {s.label}
                      </Chip>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Section>

        {/* Modal */}
        <Section label="Modal">
          <Modal.Root>
            <Modal.Trigger asChild>
              <Button variant="secondary" leadingIcon={RiPlayLine}>
                Open modal
              </Button>
            </Modal.Trigger>
            <Modal.Content className="max-w-[440px] rounded-2xl border border-border-button-default bg-background-primary-default shadow-dropdown">
              <Modal.Header
                icon={RiSparkling2Line}
                title="Start a new run"
                description="Kick off an autonomous task on the selected repo."
                className="before:border-border-button-default"
              />
              <Modal.Body>
                <p className="text-body-2-regular text-text-secondary">
                  This modal keeps its dialog behavior under a base-kit skin - Escape, the backdrop,
                  and the close button all dismiss it.
                </p>
              </Modal.Body>
              <Modal.Footer className="border-border-button-default">
                <Modal.Close asChild>
                  <Button variant="secondary" size="small">
                    Cancel
                  </Button>
                </Modal.Close>
                <Button variant="primary" size="small" leadingIcon={RiCheckLine}>
                  Start run
                </Button>
              </Modal.Footer>
            </Modal.Content>
          </Modal.Root>
        </Section>

        {/* Motion primitives */}
        <Section label="Brand motion primitives">
          <div className="flex flex-col gap-4">
            <p className="agent-progress-loading-text text-body-medium">Thinking through the plan…</p>
            <p className="text-body-2-medium text-text-primary">
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
                  className="ai-loading-pixel size-1.5 rounded-full bg-accent-500"
                  style={{ animationDelay: `${i * 120}ms` }}
                />
              ))}
            </div>
          </div>
        </Section>

        {/* Thinking orb */}
        <Section label="Thinking orb - engine-driven agent loader">
          <p className="text-body-2-regular text-text-secondary">
            A canvas-rendered dotted thought-orb (vendored from chartden). Six states drive the
            “agent is thinking” moment; useAgent uses the <code>searching</code> preset for the
            session boot phase. Grayscale- by-depth, so it tracks the theme with no token mapping.
          </p>
          <div className="flex flex-wrap items-end gap-8">
            {(["working", "searching", "shaping"] as OrbState[]).map((state) => (
              <div key={state} className="flex flex-col items-center gap-2">
                <ThinkingOrb state={state} size={64} />
                <span className="text-mono-label text-text-tertiary capitalize">{state}</span>
              </div>
            ))}
            <div className="flex items-center gap-2 self-center">
              <ThinkingOrb state="working" size={20} />
              <span className="text-body-2-regular text-text-secondary">Inline size (20px)</span>
            </div>
          </div>
        </Section>

        <Section label="Artifact workspace - shared capability contract">
          <p className="text-body-2-regular text-text-secondary">
            These rows come from the same browser-safe contract used by active session files, Live
            Artifacts, and the editor. Office and PDF edits use canonical companion state; this does
            not claim rich binary round-trip.
          </p>
          <div className="overflow-hidden rounded-xl border border-border-button-default">
            <Table aria-label="Artifact capability matrix">
              <TableHeader>
                <TableColumn isRowHeader>Workpiece</TableColumn>
                <TableColumn>Edit state</TableColumn>
                <TableColumn>Preview</TableColumn>
                <TableColumn>Actions</TableColumn>
              </TableHeader>
              <TableBody>
                {ARTIFACT_CAPABILITY_ROWS.map((row) => (
                  <TableRow key={row.kind}>
                    <TableCell>
                      <p className="text-body-2-medium text-text-primary">{row.label}</p>
                      <p className="font-mono text-caption-1-regular text-text-tertiary">
                        {row.defaultName}
                      </p>
                    </TableCell>
                    <TableCell className="font-mono text-caption-1-regular text-text-secondary">
                      {row.edit ? `${row.edit.mode}:${row.edit.state}` : "unavailable"}
                    </TableCell>
                    <TableCell className="text-caption-1-regular text-text-secondary">
                      {row.preview.inline ? row.preview.renderer : "attachment only"}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {row.actions.map((action) => (
                          <Chip key={action} color="gray">
                            {action}
                          </Chip>
                        ))}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Section>

        {/* ── AI component kit (components/ai) ─────────────────────────── */}
        <div className="animate-ai-fade-up flex flex-col gap-1 border-t border-border-button-default pt-10">
          <h2 className="text-title-2-semibold text-text-primary">AI kit</h2>
          <p className="text-body-regular text-text-secondary">
            The <code>components/ai</code> primitives ported from beautiful-ui onto the semantic
            token layer - streaming, agent activity, approvals, and tables.
          </p>
        </div>

        <Section label="AI kit · Streaming text">
          <StreamingText
            key={streamKey}
            text="Ported the AI component kit onto the base-kit tokens - streaming text, thinking disclosures, tool chips, approval cards and tables all read from the semantic scale, so they flip cleanly between light and the warm #20201f dark ladder."
            active
            sources={[
              { name: "AGENTS.md", url: "https://useagent.local/AGENTS.md" },
              { name: "beautiful-ui", url: "the component catalog" },
              { name: "Base kit tokens", url: "https://useagent.local/styles/theme.css" },
            ]}
            onRegenerate={() => setStreamKey((k) => k + 1)}
          />
        </Section>

        <Section label="AI kit · Thinking disclosure">
          <Thinking label="Working - analysing repository" active open>
            <p className="text-body-2-regular text-text-secondary">
              Reading AGENTS.md and the tailwind token scale…
            </p>
            <p className="text-body-2-regular text-text-secondary">
              Mapping base-kit status colors onto success / error / away.
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
                body: "The base-kit token scale bridged into Tailwind v4 - semantic background / text / border families plus the state color ramps.",
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

        <BeautifulUiExtras />

        <div className="h-16" />
      </div>
    </main>
  );
}
