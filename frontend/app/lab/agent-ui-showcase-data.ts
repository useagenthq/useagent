import type { CanonicalChildEventLike } from "@/components/chat/canonical-children";
import type { ApiStep } from "@/components/chat/types";

const NOW = "2026-08-16T12:00:00.000Z";

export const ACTIVITY_STEPS = [
  {
    id: "lab-read-contract",
    run_id: "run_lab_agent_ui",
    idx: 1,
    kind: "file",
    label: "Read canonical event contract",
    chip: "packages/agent-harness/src/canonical.ts",
    code_json: JSON.stringify({
      tool: "read",
      path: "packages/agent-harness/src/canonical.ts",
      output: "Canonical child and plan events verified.",
    }),
    created_at: NOW,
  },
  {
    id: "lab-run-tests",
    run_id: "run_lab_agent_ui",
    idx: 2,
    kind: "command",
    label: "Run component tests",
    chip: "bun test components/agent-ui",
    code_json: JSON.stringify({
      tool: "bash",
      command: "bun test components/agent-ui",
      output: "7 pass\n0 fail",
      exitCode: 0,
      durationMs: 842,
    }),
    created_at: NOW,
  },
] satisfies readonly ApiStep[];

export const CHILD_EVENTS = [
  {
    kind: "child.started",
    seq: 1,
    childId: "child_accessibility",
    launchToolCallId: "call_accessibility",
    title: "Accessibility review",
    state: {
      status: "running",
      summary: "Checking keyboard and screen-reader states",
      role: "reviewer",
      model: "gpt-5.6-luna",
      usage: { totalTokens: 1840, toolUses: 4 },
      resumable: true,
    },
  },
  {
    kind: "child.started",
    seq: 2,
    childId: "child_tests",
    launchToolCallId: "call_tests",
    title: "Component verification",
    state: {
      status: "running",
      summary: "Running focused Bun tests",
      role: "test engineer",
      model: "gpt-5.6-terra",
      usage: { totalTokens: 920, toolUses: 2 },
    },
  },
  {
    kind: "child.completed",
    seq: 3,
    childId: "child_tests",
    status: "ok",
    result: "Focused suite passed",
    state: {
      status: "completed",
      summary: "Focused suite passed",
      role: "test engineer",
      model: "gpt-5.6-terra",
      usage: { totalTokens: 1412, toolUses: 3 },
    },
  },
] satisfies readonly CanonicalChildEventLike[];

export const SHOWCASE_ARTIFACT = {
  id: "artifact_agent_ui_notes",
  run_id: "run_lab_agent_ui",
  thread_id: "thread_component_lab",
  name: "accessibility-notes.md",
  source_path: "artifacts/accessibility-notes.md",
  content_type: "text/markdown; charset=utf-8",
  size_bytes: 1178,
  sha256: "b8f564a151af9fa81d16dbecc5d75fe0ab1df96c59dc77a0cf048b27f2ddf8ad",
  created_at: NOW,
  preview_url: "/api/artifacts/artifact_agent_ui_notes/preview",
  download_url: "/api/artifacts/artifact_agent_ui_notes/download",
  workpiece: null,
} as const;

export const PLAN_ENTRIES = [
  { id: "inspect", text: "Inspect vendored beUI agent sources", status: "completed" },
  { id: "compose", text: "Compose canonical activity primitives", status: "completed" },
  { id: "verify", text: "Verify keyboard and screen-reader behavior", status: "in_progress" },
  { id: "ship", text: "Publish the reusable component API", status: "pending" },
] as const;
