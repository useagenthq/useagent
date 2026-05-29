"use client";

import { RiArrowRightUpLine, RiExternalLinkLine, RiSparkling2Line } from "@remixicon/react";
import type { ReactNode } from "react";
import { ActivityStepGroups } from "@/components/agent-ui/activity-step-groups";
import { ApprovalRequest } from "@/components/agent-ui/approval-request";
import { CodeDiff } from "@/components/agent-ui/code-diff";
import { LiveSubagentStatus } from "@/components/agent-ui/live-subagent-status";
import { PlanChecklist } from "@/components/agent-ui/plan-checklist";
import { QuestionRequest } from "@/components/agent-ui/question-request";
import { RichToolResult } from "@/components/agent-ui/rich-tool-result";
import { CodeBlock } from "@/components/ai/code-block";
import { StreamingText } from "@/components/ai/streaming-text";
import { Composer } from "@/components/chat/composer";
import { cnExt as cn } from "@/utils/cn";
import {
  BEUI_ACTIVITY_GROUPS,
  BEUI_AGENT_INVENTORY,
  BEUI_AGENT_LICENSE,
  BEUI_AGENT_REGISTRY_URL,
  BEUI_AGENT_SOURCE_URL,
  BEUI_APPROVAL_REQUEST,
  BEUI_CHILD_MODEL,
  BEUI_PLAN_ENTRIES,
  BEUI_PROMPT_INPUT,
  BEUI_QUESTION_REQUEST,
  BEUI_REJECTED_SURFACES,
} from "./beui-agent-inventory-data";

function ShellCard({
  slug,
  title,
  note,
  decision,
  owner,
  sourceUrl,
  children,
  wide = false,
}: {
  readonly slug: string;
  readonly title: string;
  readonly note: string;
  readonly decision: "Reuse" | "Adapt" | "Reject";
  readonly owner: string;
  readonly sourceUrl?: string;
  readonly children: ReactNode;
  readonly wide?: boolean;
}) {
  const tone =
    decision === "Reuse"
      ? "bg-status-lime-background text-status-lime-text"
      : decision === "Adapt"
        ? "bg-status-blue-background text-status-blue-text"
        : "bg-background-tertiary-default text-text-secondary";

  return (
    <section
      data-beui-agent-component={slug}
      className={cn(
        "flex flex-col gap-4 rounded-3xl border border-border-button-default bg-background-primary-default p-5 shadow-card",
        wide ? "lg:col-span-2" : "",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-caption-1-medium text-text-tertiary">{slug}</p>
          <h3 className="mt-1 text-title-3-medium text-text-primary">{title}</h3>
          <p className="mt-1 text-body-2-regular text-text-secondary">{note}</p>
        </div>
        <span className={cn("shrink-0 rounded-full px-2.5 py-1 text-caption-1-medium", tone)}>
          {decision}
        </span>
      </div>
      <div>{children}</div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-caption-1-regular text-text-tertiary">
        <span className="min-w-0 truncate">{owner}</span>
        {sourceUrl ? (
          <a
            href={sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-full border border-border-button-default bg-background-secondary-default px-2 py-1 text-caption-1-medium text-text-secondary transition-colors hover:bg-background-tertiary-default"
          >
            Source
            <RiExternalLinkLine className="size-3" aria-hidden />
          </a>
        ) : (
          <span className="rounded-full border border-border-button-default bg-background-secondary-default px-2 py-1 text-caption-1-medium">
            Local primitive
          </span>
        )}
      </div>
    </section>
  );
}

function InventoryChip({ label, decision }: { readonly label: string; readonly decision: string }) {
  const tone =
    decision === "Reuse"
      ? "bg-status-lime-background text-status-lime-text"
      : decision === "Adapt"
        ? "bg-status-blue-background text-status-blue-text"
        : "bg-background-tertiary-default text-text-secondary";

  return (
    <span
      className={cn("inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-caption-1-medium", tone)}
    >
      {label}
    </span>
  );
}

export function BeuiAgentInventory() {
  if (!BEUI_APPROVAL_REQUEST || !BEUI_QUESTION_REQUEST) {
    throw new Error("beUI inventory fixtures failed to resolve");
  }

  return (
    <section className="border-t border-border-button-default py-10">
      <div className="overflow-hidden rounded-3xl bg-foreground-icon-primary text-background-full shadow-lg">
        <div className="bg-halftone flex flex-col gap-5 p-6 sm:p-8">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="max-w-2xl">
              <div className="flex flex-wrap items-center gap-2">
                <span className="flex size-10 items-center justify-center rounded-2xl bg-accent-500 text-white">
                  <RiSparkling2Line className="size-5" aria-hidden />
                </span>
                <div>
                  <p className="font-mono text-caption-1-medium text-text-disabled">
                    {BEUI_AGENT_SOURCE_URL}
                  </p>
                  <h2 className="mt-1 text-title-1-medium text-background-full">beUI agent inventory</h2>
                </div>
              </div>
              <p className="mt-3 text-body-regular text-text-disabled">
                Compact, exact-fidelity lab examples for prompt input, grouped activity, planning,
                approvals, questions, tool output, diffs, and subagents. The live app keeps one
                shell and one sidebar; these entries are adapters or reuses, not a second chat
                product.
              </p>
            </div>
            <div className="flex flex-col items-end gap-2 text-right">
              <span className="rounded-full bg-background-primary-default/10 px-3 py-1 text-caption-1-medium text-background-full">
                {BEUI_AGENT_LICENSE} upstream
              </span>
              <a
                href={BEUI_AGENT_REGISTRY_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 rounded-full border border-background-full/30 px-3 py-1.5 text-caption-1-medium text-background-full transition-colors hover:bg-foreground-icon-hover"
              >
                Registry
                <RiArrowRightUpLine className="size-3" aria-hidden />
              </a>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {BEUI_AGENT_INVENTORY.map((item) => (
              <InventoryChip key={item.slug} label={item.label} decision={item.decision} />
            ))}
          </div>

          <div className="flex flex-wrap gap-2">
            {BEUI_REJECTED_SURFACES.map((item) => (
              <span
                key={item.slug}
                className="inline-flex items-center gap-1 rounded-full border border-background-full/30 px-2.5 py-1 text-caption-1-medium text-text-disabled"
              >
                {item.label}
                <span className="text-text-tertiary">rejected</span>
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <ShellCard
          slug="prompt-input"
          title="Prompt Input"
          note="Use the production composer so the lab reflects the live session input, command catalog, and model controls."
          decision="Reuse"
          owner="components/chat/composer.tsx"
          sourceUrl="https://beui.dev/components/agents/prompt-input"
          wide
        >
          <div className="rounded-3xl border border-border-button-default bg-background-primary-default p-3 shadow-card">
            <Composer
              variant="compact"
              placeholder="Ask the lab to inspect the next primitive…"
              defaultEngine={BEUI_PROMPT_INPUT.defaultEngine}
              defaultModel={BEUI_PROMPT_INPUT.defaultModel}
              defaultMemoryScope={BEUI_PROMPT_INPUT.defaultMemoryScope}
              commandState={BEUI_PROMPT_INPUT.commandState ?? undefined}
              enableUploads
              onSubmit={() => {}}
            />
          </div>
        </ShellCard>

        <ShellCard
          slug="agent-activity"
          title="Agent Activity"
          note="Group the canonical step grammar into phase boundaries; the rows stay inspectable and tool-specific."
          decision="Adapt"
          owner="components/chat/canonical-timeline.ts"
          sourceUrl="https://beui.dev/components/agents/agent-activity"
        >
          <ActivityStepGroups groups={BEUI_ACTIVITY_GROUPS} activeStepId="lab-run-tests" />
        </ShellCard>

        <ShellCard
          slug="todo-list"
          title="Todo List"
          note="Plan state comes from the durable task model instead of a guessed trace or a fake progress bar."
          decision="Reuse"
          owner="components/agent-ui/plan-checklist.tsx"
          sourceUrl="https://beui.dev/components/agents/todo-list"
        >
          <PlanChecklist title="Implementation plan" entries={BEUI_PLAN_ENTRIES} />
        </ShellCard>

        <ShellCard
          slug="human-in-the-loop"
          title="Approvals and Questions"
          note="Keep the two interruption states separate: one is permission, the other is clarification."
          decision="Reuse"
          owner="components/chat/native-approval-card.tsx + components/chat/question-card.tsx"
          wide
        >
          <div className="grid gap-4 lg:grid-cols-2">
            <ApprovalRequest
              request={BEUI_APPROVAL_REQUEST}
              submitting={false}
              error={null}
              onRespond={() => {}}
            />
            <QuestionRequest
              request={BEUI_QUESTION_REQUEST}
              submitting={false}
              error={null}
              onSubmit={() => {}}
            />
          </div>
        </ShellCard>

        <ShellCard
          slug="tool-result"
          title="Tool Result"
          note="Bound the terminal/output surface with a completion state, preview, and inspectable result block."
          decision="Adapt"
          owner="components/agent-ui/rich-tool-result.tsx"
          sourceUrl="https://beui.dev/components/agents/tool-result"
        >
          <RichToolResult
            openByDefault
            event={{
              toolCallId: "tool_beui_1",
              name: "bun test components/agent-ui",
              server: "terminal",
              status: "ok",
              durationMs: 842,
              preview: "7 pass, 0 fail",
              result: "7 pass\n0 fail",
            }}
          />
        </ShellCard>

        <ShellCard
          slug="file-diff"
          title="Code Block / File Diff"
          note="Pair generated source and file changes so review stays inspectable instead of becoming a loose transcript."
          decision="Adapt"
          owner="components/agent-ui/code-diff.tsx"
          sourceUrl="https://beui.dev/components/agents/file-diff"
          wide
        >
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(16rem,0.85fr)]">
            <CodeBlock
              filename="question-request.tsx"
              language="tsx"
              code={`"use client";

export function QuestionRequest(...) {
  return <QuestionCard {...props} />;
}`}
            />
            <CodeDiff
              title="Question request adapter"
              code={{
                filename: "question-request.tsx",
                language: "tsx",
                code: `export function QuestionRequest({ request, ...props }) {
  return <QuestionCard request={request} {...props} />;
}`,
              }}
              changes={[
                {
                  cells: ["question-request.tsx", "wrapper", "adds durable question surface"],
                  status: "added",
                },
                {
                  cells: ["agent-ui/index.ts", "export", "promotes shared primitive"],
                  status: "changed",
                },
              ]}
            />
          </div>
        </ShellCard>

        <ShellCard
          slug="subagents"
          title="Subagents"
          note="Rehydrate child-session state from canonical child lifecycle events; no guessed ownership, no placeholder cards."
          decision="Reuse"
          owner="components/agent-ui/live-subagent-status.tsx"
          sourceUrl="https://beui.dev/components/agents/agent-loading-states"
        >
          <LiveSubagentStatus model={BEUI_CHILD_MODEL} />
        </ShellCard>

        <ShellCard
          slug="streaming-response"
          title="Streaming Response"
          note="Keep the response surface stable while content arrives, then expose source inspection after completion."
          decision="Adapt"
          owner="components/ai/streaming-text.tsx"
          sourceUrl="https://beui.dev/components/agents/streaming-response"
          wide
        >
          <StreamingText
            text="A stable response surface can keep links readable, preserve layout, and reveal citations only after the answer settles."
            active={false}
            sources={[
              { name: "beUI agents", url: BEUI_AGENT_SOURCE_URL },
              { name: "AlignUI tokens", url: "https://alignui.com" },
              { name: "useAgent lab", url: "/lab" },
            ]}
            onRegenerate={() => {}}
          />
        </ShellCard>
      </div>
    </section>
  );
}
