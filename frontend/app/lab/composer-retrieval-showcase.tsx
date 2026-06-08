"use client";

import {
  RiAttachment2,
  RiBook2Line,
  RiFileList2Line,
  RiGithubFill,
  RiGlobalLine,
  RiPencilLine,
  RiSlackFill,
  RiSparkling2Line,
  RiTerminalBoxLine,
} from "@remixicon/react";
import type * as React from "react";
import { ContextCardStack } from "@/components/ai/context-card";
import {
  PromptBar,
  type PromptCommand,
  type PromptModel,
  type PromptSource,
} from "@/components/ai/prompt-bar";
import { ToolCallFold } from "@/components/ai/tool-call-fold";

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4 border-t border-border-button-default py-8">
      <p className="text-mono-label text-text-tertiary">{label}</p>
      {children}
    </section>
  );
}

const SOURCES: PromptSource[] = [
  {
    key: "attach",
    name: "Add photos & files",
    desc: "Upload from your computer",
    icon: RiAttachment2,
    attach: true,
  },
  { key: "github", name: "GitHub", desc: "Repos, issues, pull requests", icon: RiGithubFill },
  { key: "slack", name: "Slack", desc: "Channels and threads", icon: RiSlackFill, connect: true },
  { key: "knowledge", name: "Knowledge", desc: "Org wiki and docs", icon: RiBook2Line },
  { key: "web", name: "Web search", desc: "Real-time news and info", icon: RiGlobalLine },
];

const COMMANDS: PromptCommand[] = [
  { key: "plan", name: "/plan", desc: "Draft an implementation plan" },
  { key: "review", name: "/review", desc: "Review the current diff" },
  { key: "verify", name: "/verify", desc: "Run checks and report" },
  { key: "summarize", name: "/summarize", desc: "Digest the thread so far" },
];

const MODELS: PromptModel[] = [
  { key: "sonnet", name: "Claude Sonnet", tag: "Default" },
  { key: "opus", name: "Claude Opus", tag: "Deep work" },
  { key: "haiku", name: "Claude Haiku", tag: "Fast" },
];

const ATTACH_POOL = ["run-trace.png", "usage-export.csv", "deploy-notes.md"];

const DICTATION_SAMPLE = "Compare this week's runs to last Friday's soak";

function PromptBarDemo({ variant }: { variant: "rounded" | "pill" }) {
  return (
    <div className="flex min-h-[320px] w-full max-w-2xl flex-col justify-end pb-2">
      <PromptBar
        variant={variant}
        sources={SOURCES}
        commands={COMMANDS}
        models={MODELS}
        attachPool={ATTACH_POOL}
        dictationSample={DICTATION_SAMPLE}
      />
    </div>
  );
}

export function ComposerRetrievalShowcase() {
  return (
    <>
      <div className="animate-ai-fade-up flex flex-col gap-1 border-t border-border-button-default pt-10">
        <h2 className="text-title-2-semibold text-text-primary">Composer + retrieval</h2>
        <p className="text-body-regular text-text-secondary">
          The refreshed composer, retrieval, and activity primitives. Type @ for sources, / for
          commands; pick the attach row to add file chips; both composer radii render below.
        </p>
      </div>

      <Section label="Composer · Prompt bar - rounded">
        <PromptBarDemo variant="rounded" />
      </Section>

      <Section label="Composer · Prompt bar - pill">
        <PromptBarDemo variant="pill" />
      </Section>

      <Section label="Retrieval · Context cards with source files">
        <div className="max-w-xl">
          <ContextCardStack
            label="All chunks"
            count={32}
            cards={[
              {
                title: "Sandbox provisioning rule",
                meta: "290 characters",
                icon: RiFileList2Line,
                body: "Sandboxes are deleted and API-verified after every test run; orphaned instances are swept nightly.",
                source: { name: "Sandbox Runbook.pdf", badge: "PDF", tone: "red" },
              },
              {
                title: "Weekly usage row",
                meta: "1,250 characters",
                body: "Model burn by engine: primary 62%, secondary 27%, fallback 11%; sandbox footprint stays under the org memory cap.",
                source: { name: "usage-export.csv", badge: "CSV", tone: "green" },
              },
              {
                title: "Composer conventions",
                meta: "640 characters",
                body: "Composer surfaces read the shared command catalog; slash commands stay session-scoped and engine-agnostic.",
                source: { name: "AGENTS.md", badge: "MD", tone: "blue" },
              },
            ]}
          />
        </div>
      </Section>

      <Section label="Activity · Tool call fold">
        <div className="max-w-sm">
          <ToolCallFold
            summary="4 tool calls, 2 messages"
            rows={[
              {
                icon: RiSparkling2Line,
                label: "Thinking",
                chip: "Planning the retry strategy...",
                detail: [
                  { text: "Failed runs cluster on sandbox boot, so retry there first." },
                  { text: "Backoff caps at three attempts per thread." },
                ],
              },
              {
                icon: RiPencilLine,
                label: "Write 204 lines",
                chip: "engine-adapter.ts",
                mono: true,
                detailMono: true,
                detail: [
                  { text: "+ const stale = runs.filter((r) => r.startedAt < cutoff)", tone: "add" },
                  { text: '+ return recover(stale, { mode: "reconcile" })', tone: "add" },
                ],
              },
              {
                icon: RiTerminalBoxLine,
                label: "Rebuild and verify",
                chip: "bun run typecheck",
                mono: true,
                detailMono: true,
                detail: [{ text: "✓ built in 1.2s" }, { text: "✓ 34 checks passed" }],
              },
              {
                icon: RiFileList2Line,
                label: "Read image",
                chip: "run-trace.png",
                mono: true,
                detail: [
                  { text: "1280 × 720 · flame chart, three runs." },
                  { text: "Boot phase shrinks 40% with the warm pool." },
                ],
              },
            ]}
            diffs={[
              {
                file: "engine-adapter.ts",
                add: 74,
                del: 41,
                lines: [
                  { text: "const runs = staleRuns(week);", tone: "ctx" },
                  { text: "const retriable = runs;", tone: "del" },
                  { text: "const retriable = runs.filter(", tone: "add" },
                  { text: "  (r) => r.phase === 'boot',", tone: "add" },
                  { text: ");", tone: "add" },
                ],
              },
              {
                file: "retry-policy.ts",
                add: 13,
                del: 0,
                lines: [
                  { text: "export const policy = {", tone: "ctx" },
                  { text: "  maxAttempts: 3,", tone: "add" },
                  { text: "  backoffMs: 2_000,", tone: "add" },
                  { text: "};", tone: "ctx" },
                ],
              },
              {
                file: "worker.ts",
                add: 8,
                del: 2,
                lines: [
                  { text: "const attempts = 1;", tone: "del" },
                  { text: "const attempts = policy.maxAttempts;", tone: "add" },
                ],
              },
            ]}
            moreLabel="+2 more"
          />
        </div>
      </Section>
    </>
  );
}
