"use client";

import { RiArrowRightUpLine, RiSparkling2Line } from "@remixicon/react";
import { useMemo, useState } from "react";
import {
  ActivityStepGroups,
  type ApprovalDecision,
  ApprovalRequest,
  ArtifactPreview,
  CodeDiff,
  LiveSubagentStatus,
  PlanChecklist,
  RichToolResult,
} from "@/components/agent-ui";
import { deriveCanonicalChildren } from "@/components/chat/canonical-children";
import {
  ACTIVITY_STEPS,
  CHILD_EVENTS,
  PLAN_ENTRIES,
  SHOWCASE_ARTIFACT,
} from "./agent-ui-showcase-data";

function ShowcaseCell({
  id,
  title,
  description,
  children,
  wide = false,
}: {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly children: React.ReactNode;
  readonly wide?: boolean;
}) {
  return (
    <section
      id={id}
      data-agent-ui-component={id}
      className={`scroll-mt-6 rounded-3xl border border-stroke-soft-200 bg-bg-white-0 p-5 shadow-regular-xs ${wide ? "lg:col-span-2" : ""}`}
    >
      <div className="mb-4">
        <h3 className="text-title-h6 text-text-strong-950">{title}</h3>
        <p className="mt-1 text-paragraph-sm text-text-sub-600">{description}</p>
      </div>
      {children}
    </section>
  );
}

export function AgentUiShowcase() {
  const [approvalDecision, setApprovalDecision] = useState<ApprovalDecision | null>(null);
  const childModel = useMemo(() => deriveCanonicalChildren(CHILD_EVENTS), []);

  return (
    <section id="agent-ui" className="scroll-mt-6 border-t border-stroke-soft-200 py-10">
      <div className="overflow-hidden rounded-3xl bg-bg-strong-950 text-text-white-0 shadow-regular-lg">
        <div className="bg-halftone flex flex-col gap-5 p-6 sm:p-8">
          <span className="flex size-10 items-center justify-center rounded-xl bg-primary-base text-static-white">
            <RiSparkling2Line className="size-5" aria-hidden />
          </span>
          <div className="max-w-2xl">
            <p className="font-mono text-label-xs text-text-disabled-300">beUI.dev × Skynet</p>
            <h2 className="mt-2 text-title-h4 text-text-white-0">Agent interface primitives</h2>
            <p className="mt-2 text-paragraph-md text-text-disabled-300">
              Production components for canonical activity, approvals, artifacts, tool results, and
              live subagents. The examples below use lab-only fixtures; the components accept real
              Skynet view models.
            </p>
          </div>
          <nav aria-label="Agent component examples" className="flex flex-wrap gap-2">
            {[
              ["activity-steps", "Activity"],
              ["plan-checklist", "Plan"],
              ["approval-request", "Approval"],
              ["rich-tool-result", "Tool result"],
              ["code-diff", "Code / diff"],
              ["artifact-preview", "Artifact"],
              ["subagent-status", "Subagents"],
            ].map(([href, label]) => (
              <a
                key={href}
                href={`#${href}`}
                className="inline-flex items-center gap-1 rounded-full border border-stroke-strong-400 px-3 py-1.5 text-label-xs text-text-white-0 hover:bg-bg-surface-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-base"
              >
                {label}
                <RiArrowRightUpLine className="size-3" aria-hidden />
              </a>
            ))}
          </nav>
        </div>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <ShowcaseCell
          id="activity-steps"
          title="Activity step groups"
          description="Phase boundaries around the canonical ApiStep projection."
        >
          <ActivityStepGroups
            groups={[
              {
                id: "research",
                label: "Understand the contract",
                description: "Read the canonical event vocabulary before composing UI.",
                status: "completed",
                steps: ACTIVITY_STEPS.slice(0, 1),
              },
              {
                id: "verification",
                label: "Verify the component set",
                status: "running",
                steps: ACTIVITY_STEPS.slice(1),
              },
            ]}
            activeStepId="lab-run-tests"
          />
        </ShowcaseCell>

        <ShowcaseCell
          id="plan-checklist"
          title="Plan and checklist"
          description="Canonical plan entries with explicit progress and status semantics."
        >
          <PlanChecklist title="Component delivery plan" entries={PLAN_ENTRIES} />
        </ShowcaseCell>

        <ShowcaseCell
          id="approval-request"
          title="Approval request"
          description="The same decision vocabulary used by the live T3 approval flow."
        >
          {approvalDecision ? (
            <div
              role="status"
              className="rounded-2xl bg-success-lighter p-4 text-label-sm text-success-base"
            >
              Lab decision recorded: {approvalDecision}
            </div>
          ) : (
            <ApprovalRequest
              request={{
                id: "approval_lab_network",
                sessionId: "session_lab",
                requestKind: "command",
                detail: "bun test components/agent-ui",
              }}
              onRespond={setApprovalDecision}
            />
          )}
        </ShowcaseCell>

        <ShowcaseCell
          id="rich-tool-result"
          title="Rich tool result"
          description="Expandable canonical tool metadata, preview, and full output."
        >
          <RichToolResult
            openByDefault
            resultLanguage="json"
            event={{
              toolCallId: "tool_8f19",
              name: "inspect_accessibility_tree",
              server: "browser",
              status: "ok",
              durationMs: 428,
              preview: "7 interactive controls; all have accessible names.",
              result: JSON.stringify({ violations: 0, controls: 7, landmarks: 3 }, null, 2),
            }}
          />
        </ShowcaseCell>

        <ShowcaseCell
          id="code-diff"
          title="Code and diff"
          description="The vendored code and diff ports composed into one review surface."
          wide
        >
          <CodeDiff
            title="Approval state adapter"
            code={{
              filename: "approval-adapter.ts",
              language: "ts",
              code: `export function approvalLabel(kind: RequestKind) {
  return APPROVAL_LABELS[kind];
}`,
            }}
            changes={[
              { cells: ["approval-adapter.ts", "approvalLabel", "typed lookup"], status: "added" },
              {
                cells: ["session-view.tsx", "inline branch", "shared primitive"],
                status: "changed",
              },
            ]}
          />
        </ShowcaseCell>

        <ShowcaseCell
          id="artifact-preview"
          title="Artifact preview"
          description="Durable artifact metadata plus an inline source preview."
        >
          <ArtifactPreview
            artifact={SHOWCASE_ARTIFACT}
            textPreview={{
              language: "markdown",
              content: `# Accessibility notes

- Approval actions retain visible focus.
- Live status changes are announced politely.
- Progress exposes a numeric value.`,
            }}
          />
        </ShowcaseCell>

        <ShowcaseCell
          id="subagent-status"
          title="Live subagent status"
          description="Rendered directly from the canonical child lifecycle model."
        >
          <LiveSubagentStatus model={childModel} />
        </ShowcaseCell>
      </div>
    </section>
  );
}
