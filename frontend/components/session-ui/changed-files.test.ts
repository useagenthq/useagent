import { expect, test } from "bun:test";
import { type TimelineNode } from "@/components/chat/timeline";
import { type ApiStep } from "@/components/chat/types";
import { changedFilesFromTimeline, contextWindowFromChildUsage } from "./adapter";
import {
  buildTurnDiffTree,
  changedFileName,
  selectChangedFilePreview,
  shouldAutoExpandChangedFiles,
  summarizeChangedFileScopes,
  summarizeTurnDiffStats,
  type ChangedFile,
} from "./changed-files";

const FILES: ChangedFile[] = [
  { path: "backend/src/gateway/routes.ts", kind: "edit", additions: 6, deletions: 3 },
  { path: "backend/src/gateway/retry.ts", kind: "edit", additions: 3, deletions: 2 },
  { path: "frontend/app/page.tsx", kind: "edit" },
  { path: "README.md", kind: "edit", additions: 2, deletions: 0 },
];

test("summarizeTurnDiffStats sums only entries carrying both counts", () => {
  expect(summarizeTurnDiffStats(FILES)).toEqual({ additions: 11, deletions: 5 });
  expect(summarizeTurnDiffStats([])).toEqual({ additions: 0, deletions: 0 });
});

test("buildTurnDiffTree compacts single-child directory chains and rolls up stats", () => {
  const tree = buildTurnDiffTree(FILES);
  // Directories sort before files; single-child chains compact into one label.
  expect(tree.map((n) => n.name)).toEqual(["backend/src/gateway", "frontend/app", "README.md"]);
  const backend = tree[0];
  if (backend?.kind !== "directory") throw new Error("expected directory");
  expect(backend.stat).toEqual({ additions: 9, deletions: 5 });
  expect(backend.children.map((n) => n.name)).toEqual(["retry.ts", "routes.ts"]);
  // A stat-less file renders as a null stat leaf, never a fabricated 0/0.
  const frontend = tree[1];
  if (frontend?.kind !== "directory") throw new Error("expected directory");
  expect(frontend.children[0]).toMatchObject({ kind: "file", name: "page.tsx", stat: null });
});

test("scope summary and preview pick diverse top-level scopes first", () => {
  expect(changedFileName("backend/src/gateway/routes.ts")).toBe("routes.ts");
  expect(summarizeChangedFileScopes(FILES)).toEqual([
    { label: "backend", fileCount: 2 },
    { label: "frontend", fileCount: 1 },
    { label: "root", fileCount: 1 },
  ]);
  // One file per scope before filling from the top.
  expect(selectChangedFilePreview(FILES).map((f) => f.path)).toEqual([
    "backend/src/gateway/routes.ts",
    "frontend/app/page.tsx",
    "README.md",
  ]);
});

test("auto-expand policy: latest turn, few files, small diff", () => {
  expect(shouldAutoExpandChangedFiles(FILES, true)).toBe(true);
  expect(shouldAutoExpandChangedFiles(FILES, false)).toBe(false);
  const big = [{ path: "a.ts", kind: "edit", additions: 500, deletions: 0 }];
  expect(shouldAutoExpandChangedFiles(big, true)).toBe(false);
});

// ── adapter: canonical timeline -> changed files ─────────────────────────────

let idx = 0;
function toolNode(code: Record<string, unknown>): TimelineNode {
  idx += 1;
  const step: ApiStep = {
    id: `cf-${idx}`,
    run_id: "cf-run",
    idx,
    kind: "command",
    label: String(code.tool ?? "tool"),
    chip: null,
    code_json: JSON.stringify(code),
    created_at: "2026-08-17T09:00:00Z",
  };
  return { kind: "tool", key: step.id, step };
}

test("changedFilesFromTimeline aggregates file mutations per path, honest stats only", () => {
  const nodes: TimelineNode[] = [
    // Read tools never count as changes.
    toolNode({ tool: "read", input: { file_path: "backend/src/routes.ts" } }),
    toolNode({
      tool: "edit",
      input: {
        file_path: "backend/src/routes.ts",
        old_string: "one line",
        new_string: "line 1\nline 2\nline 3",
      },
    }),
    // A Write mirrors content, not a diff: path recorded, stat stays unknown.
    toolNode({
      tool: "write",
      input: { file_path: "frontend/app/page.tsx", content: "export default () => null;" },
    }),
    // Second edit of the SAME path merges: stats sum, first-touched order kept.
    toolNode({
      tool: "edit",
      input: {
        file_path: "backend/src/routes.ts",
        old_string: "a\nb",
        new_string: "a\nb\nc\nd",
      },
    }),
    // Durable file receipts join the aggregate; create reads as an add.
    {
      kind: "file",
      key: "cf-receipt",
      file: { path: "backend/src/registry.ts", changeType: "create" },
    },
    { kind: "text", key: "cf-text", text: "done" },
  ];

  expect(changedFilesFromTimeline(nodes)).toEqual([
    { path: "backend/src/routes.ts", kind: "edit", additions: 7, deletions: 3 },
    { path: "frontend/app/page.tsx", kind: "edit" },
    { path: "backend/src/registry.ts", kind: "add" },
  ]);
});

test("contextWindowFromChildUsage binds cumulative totals; maxTokens stays caller-supplied", () => {
  expect(contextWindowFromChildUsage({ totalTokens: 61_400 })).toEqual({
    usedTokens: 61_400,
    maxTokens: null,
  });
  expect(contextWindowFromChildUsage({ totalTokens: 61_400 }, 200_000)).toEqual({
    usedTokens: 61_400,
    maxTokens: 200_000,
  });
});
