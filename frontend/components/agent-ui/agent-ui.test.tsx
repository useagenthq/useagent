import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivityStepGroups } from "./activity-step-groups";
import { ApprovalRequest } from "./approval-request";
import { ArtifactPreview } from "./artifact-preview";
import { LiveSubagentStatus } from "./live-subagent-status";
import { PlanChecklist } from "./plan-checklist";
import { QuestionRequest } from "./question-request";
import { RichToolResult } from "./rich-tool-result";

describe("agent UI accessibility contracts", () => {
  test("exposes canonical plan progress and per-entry state", () => {
    const html = renderToStaticMarkup(
      <PlanChecklist
        title="Release plan"
        entries={[
          { id: "one", text: "Inspect", status: "completed" },
          { id: "two", text: "Implement", status: "in_progress" },
          { id: "three", text: "Verify", status: "pending" },
          { id: "four", text: "Discarded", status: "cancelled" },
        ]}
      />,
    );

    expect(html).toContain('aria-label="Release plan"');
    // Collapsible header defaults open and states the completion count aloud.
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("1/4");
    expect(html).toContain('aria-label="1 of 4 complete"');
    // Completed and cancelled entries strike through; every entry names its state.
    expect(html).toContain("line-through");
    expect(html).toContain("Completed");
    expect(html).toContain("In progress");
    expect(html).toContain("Cancelled");
  });

  test("morphs to an all-done card and honors a collapsed default", () => {
    const html = renderToStaticMarkup(
      <PlanChecklist
        title="Done plan"
        defaultOpen={false}
        entries={[
          { id: "a", text: "Alpha", status: "completed" },
          { id: "b", text: "Beta", status: "completed" },
        ]}
      />,
    );

    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("2/2");
    expect(html).toContain('aria-label="2 of 2 complete"');
    // Collapsed: the item list is not mounted.
    expect(html).not.toContain("Alpha");
  });

  test("keeps canonical tool rows inside named activity phases", () => {
    const html = renderToStaticMarkup(
      <ActivityStepGroups
        activeStepId="step-1"
        groups={[
          {
            id: "verify",
            label: "Verify changes",
            status: "running",
            steps: [
              {
                id: "step-1",
                run_id: "run-1",
                idx: 1,
                kind: "command",
                label: "Run focused tests",
                chip: "bun test components/agent-ui",
                code_json: JSON.stringify({ tool: "bash", command: "bun test" }),
                created_at: "2026-08-16T12:00:00.000Z",
              },
            ],
          },
        ]}
      />,
    );

    expect(html).toContain('aria-label="Agent activity"');
    expect(html).toContain('aria-label="Verify changes"');
    expect(html).toContain("In progress");
    expect(html).toContain("bun test");
  });

  test("disables every approval action while a response is in flight", () => {
    const html = renderToStaticMarkup(
      <ApprovalRequest
        request={{
          id: "approval-1",
          sessionId: "session-1",
          requestKind: "file-change",
          detail: "frontend/components/agent-ui/index.ts",
        }}
        submitting
        error="Response could not be delivered"
        onRespond={() => {}}
      />,
    );

    expect(html).toContain('data-testid="native-approval-card"');
    expect(html.match(/disabled=""/g)).toHaveLength(4);
    expect(html).toContain("Approval required to change files");
    expect(html).toContain("Response could not be delivered");
  });

  test("promotes the durable question state through the shared question card", () => {
    const html = renderToStaticMarkup(
      <QuestionRequest
        request={{
          id: "question-1",
          sessionId: "session-1",
          questions: [
            {
              header: "Scope",
              question: "What should the lab surface show?",
              options: [{ label: "Inventory", description: "Show the registry and examples" }],
              multiple: false,
              custom: true,
            },
          ],
        }}
        submitting={false}
        error={null}
        onSubmit={() => {}}
      />,
    );

    expect(html).toContain('data-testid="native-question-card"');
    expect(html).toContain("Skynet needs your input");
    expect(html).toContain("What should the lab surface show?");
  });

  test("announces tool and subagent lifecycle state without provider-specific data", () => {
    const toolHtml = renderToStaticMarkup(
      <RichToolResult
        openByDefault
        event={{
          toolCallId: "tool-1",
          name: "typecheck",
          status: "ok",
          durationMs: 400,
          result: "0 errors",
        }}
      />,
    );
    const subagentHtml = renderToStaticMarkup(
      <LiveSubagentStatus
        model={{
          cards: [
            {
              id: "child-card",
              title: "Review accessibility",
              childSessionId: "child-1",
              callId: "call-1",
              aliases: ["child-1", "call-1"],
              status: "Audit complete",
              startedAt: 1,
              lastActivityAt: 2,
            },
          ],
          ownerByStep: new Map(),
          fidelity: new Map([
            [
              "child-1",
              {
                callId: "call-1",
                childSessionId: "child-1",
                status: "completed",
                resultText: "Audit complete",
                progress: "Audit complete",
                lastToolName: "browser",
                recentActivity: [],
                usage: { totalTokens: 1250 },
                model: "model-1",
                role: "reviewer",
                resumable: false,
              },
            ],
          ]),
        }}
      />,
    );

    expect(toolHtml).toContain('role="status"');
    expect(toolHtml).toContain("Completed");
    expect(toolHtml).toContain("400 ms");
    expect(subagentHtml).toContain('aria-live="polite"');
    expect(subagentHtml).toContain("Completed");
    expect(subagentHtml).toContain("1.3K tokens");
  });

  test("gives artifact preview and download controls distinct accessible names", () => {
    const html = renderToStaticMarkup(
      <ArtifactPreview
        artifact={{
          id: "artifact-1",
          run_id: "run-1",
          thread_id: "thread-1",
          name: "result.md",
          source_path: "artifacts/result.md",
          content_type: "text/markdown; charset=utf-8",
          size_bytes: 2048,
          sha256: "a".repeat(64),
          created_at: "2026-08-16T12:00:00.000Z",
          preview_url: "/preview/artifact-1",
          download_url: "/download/artifact-1",
          preview_pdf_url: null,
          workpiece: null,
        }}
        textPreview={{ content: "# Result", language: "markdown" }}
      />,
    );

    expect(html).toContain('aria-label="Artifact preview: result.md"');
    expect(html).toContain('aria-label="Open preview of result.md"');
    expect(html).toContain('aria-label="Download result.md"');
    expect(html).toContain("2.0 KB");
  });
});
