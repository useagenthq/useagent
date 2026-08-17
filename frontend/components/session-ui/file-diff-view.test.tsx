import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { DiffPane } from "@/components/chat/diff-pane";
import type { ApiStep, StepKind } from "@/components/chat/types";
import * as Tooltip from "@/components/ui/tooltip";
import { type ChangedFile } from "./changed-files";
import {
  type DiffHunk,
  diffLinesFromEdit,
  filePatchesFromSteps,
  hunksFromStep,
  parsePatchLines,
  FileDiffView,
} from "./file-diff-view";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

function render(ui: React.ReactElement): string {
  return renderToStaticMarkup(<Tooltip.Provider>{ui}</Tooltip.Provider>);
}

let stepId = 0;
function step(kind: StepKind, label: string, code: unknown): ApiStep {
  stepId += 1;
  return {
    id: `step-${stepId}`,
    run_id: "run-1",
    idx: stepId,
    kind,
    label,
    chip: kind === "file" ? "file" : "bash",
    code_json: code === null ? null : JSON.stringify(code),
    created_at: "2026-08-17T00:00:00.000Z",
  };
}

// Real opencode server shapes (engines/opencode-server.ts toolStep): file tools
// emit {tool, input, output} with camelCase filePath/oldString/newString.
const OPENCODE_EDIT = step("file", "app.ts", {
  tool: "edit",
  input: {
    filePath: "src/app.ts",
    oldString: "const a = 1;\nconst b = 2;",
    newString: "const a = 10;\nconst b = 20;\nconst c = 30;",
  },
  output: "edited",
});

// Claude ACP shape: snake_case file_path/old_string/new_string.
const ACP_EDIT = step("file", "retry.ts", {
  tool: "edit",
  input: {
    file_path: "backend/src/retry.ts",
    old_string: "return null;",
    new_string: "return backoff(attempt);",
  },
});

const WRITE = step("file", "notes.md", {
  tool: "write",
  input: { filePath: "docs/notes.md", content: "# Notes\n\nHello\n" },
});

const PATCH = step("file", "routes.ts", {
  tool: "patch",
  input: {
    filePath: "src/routes.ts",
    patch: "--- a/src/routes.ts\n+++ b/src/routes.ts\n@@ -1,2 +1,2 @@\n context\n-old line\n+new line",
  },
});

const STATS_ONLY = step("file", "opaque.ts", {
  tool: "edit",
  input: { filePath: "src/opaque.ts" },
});

describe("patch recovery (pure)", () => {
  test("parsePatchLines classifies unified-diff rows and strips the +/- gutter", () => {
    const lines = parsePatchLines(
      "--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n",
    );
    expect(lines.map((l) => l.tone)).toEqual(["meta", "meta", "meta", "context", "del", "add"]);
    expect(lines.at(-2)?.text).toBe("old");
    expect(lines.at(-1)?.text).toBe("new");
    // Codex apply_patch envelope rows are meta, not content.
    expect(parsePatchLines("*** Begin Patch\n*** Update File: a.ts\n+added")[0]?.tone).toBe("meta");
    expect(parsePatchLines("*** Begin Patch\n*** Update File: a.ts\n+added")[2]).toEqual({
      tone: "add",
      text: "added",
    });
  });

  test("diffLinesFromEdit renders the replaced fragment as dels then adds", () => {
    expect(diffLinesFromEdit("a\nb", "c")).toEqual([
      { tone: "del", text: "a" },
      { tone: "del", text: "b" },
      { tone: "add", text: "c" },
    ]);
    expect(diffLinesFromEdit(null, null)).toEqual([]);
  });

  test("hunksFromStep recovers each recorded payload shape and never fabricates", () => {
    // opencode camelCase edit
    const [openHunk] = hunksFromStep(OPENCODE_EDIT);
    expect(openHunk?.map((l) => l.tone)).toEqual(["del", "del", "add", "add", "add"]);
    // ACP snake_case edit
    expect(hunksFromStep(ACP_EDIT)[0]).toEqual([
      { tone: "del", text: "return null;" },
      { tone: "add", text: "return backoff(attempt);" },
    ]);
    // MultiEdit: one hunk per edit entry
    const multi = step("file", "m.ts", {
      tool: "multiedit",
      input: {
        file_path: "src/m.ts",
        edits: [
          { old_string: "x", new_string: "y" },
          { old_string: "p", new_string: "q" },
        ],
      },
    });
    expect(hunksFromStep(multi)).toHaveLength(2);
    // Write: the whole written body as additions
    expect(hunksFromStep(WRITE)[0]?.every((l) => l.tone === "add")).toBe(true);
    expect(hunksFromStep(WRITE)[0]?.map((l) => l.text)).toEqual(["# Notes", "", "Hello"]);
    // Explicit patch body
    expect(hunksFromStep(PATCH)[0]?.some((l) => l.tone === "meta")).toBe(true);
    // No recorded patch text -> nothing, never invented
    expect(hunksFromStep(STATS_ONLY)).toEqual([]);
    expect(hunksFromStep(step("file", "bare.ts", null))).toEqual([]);
  });

  test("filePatchesFromSteps attributes single-file mutations only, in step order", () => {
    const readStep = step("command", "read", {
      tool: "read",
      input: { filePath: "src/app.ts" },
      output: "const a = 1;",
    });
    // A multi-file receipt cannot attribute its body to one path.
    const multiFile = step("file", "2 files", [
      { path: "a.ts", kind: "edit" },
      { path: "b.ts", kind: "edit" },
    ]);
    const again = step("file", "app.ts", {
      tool: "edit",
      input: { filePath: "src/app.ts", old_string: "const c = 30;", new_string: "const c = 31;" },
    });
    const patches = filePatchesFromSteps([readStep, OPENCODE_EDIT, multiFile, again, STATS_ONLY]);
    expect([...patches.keys()]).toEqual(["src/app.ts"]);
    expect(patches.get("src/app.ts")).toHaveLength(2);
  });
});

describe("FileDiffView", () => {
  const FILES: ChangedFile[] = [
    { path: "src/app.ts", kind: "edit", additions: 3, deletions: 2 },
    { path: "src/opaque.ts", kind: "edit" },
  ];
  const PATCHES = new Map<string, DiffHunk[]>([
    ["src/app.ts", hunksFromStep(OPENCODE_EDIT)],
  ]);

  test("renders the changed-files index over per-file unified diff sections", () => {
    const html = render(<FileDiffView files={FILES} patches={PATCHES} />);
    expect(html).toContain('data-session-ui="file-diff-view"');
    // Index card (vendored grammar) with the honest aggregate stat.
    expect(html).toContain('data-session-ui="changed-files-card"');
    expect(html).toContain('aria-label="3 additions, 2 deletions"');
    // Per-file section, expanded by default for a small change set.
    expect(html).toContain('data-diff-file="src/app.ts"');
    expect(html).toContain('aria-expanded="true"');
    // Diff lines: mono font, add/del tones at low alpha.
    expect(html).toContain("font-mono");
    expect(html).toContain("bg-success-base/10");
    expect(html).toContain("bg-error-base/10");
    expect(html).toContain("const a = 10;");
    expect(html).toContain("const a = 1;");
  });

  test("a file without recorded patch text gets stats plus an explicit note", () => {
    const html = render(<FileDiffView files={FILES} patches={PATCHES} />);
    expect(html).toContain('data-diff-file="src/opaque.ts"');
    expect(html).toContain("Patch content not recorded for this change");
  });

  test("renders nothing without changed files", () => {
    expect(render(<FileDiffView files={[]} patches={new Map()} />)).toBe("");
  });
});

describe("DiffPane", () => {
  test("derives the thread change set from durable steps and renders the diff view", () => {
    const html = render(
      <DiffPane turns={[{ steps: [OPENCODE_EDIT, STATS_ONLY], live: false }]} />,
    );
    expect(html).toContain('data-testid="diff-pane"');
    expect(html).toContain('data-diff-file="src/app.ts"');
    expect(html).toContain('data-diff-file="src/opaque.ts"');
    expect(html).toContain("bg-success-base/10");
  });

  test("shows an honest empty state before any file change exists", () => {
    const settled = render(<DiffPane turns={[{ steps: [], live: false }]} />);
    expect(settled).toContain("No file changes were recorded.");
    const live = render(<DiffPane turns={[{ steps: [], live: true }]} />);
    expect(live).toContain("Waiting for the first file change…");
  });
});

describe("Diff surface wiring contract", () => {
  test("the chooser card is enabled exactly when a real change set exists", () => {
    const chooser = read("../chat/surface-chooser.tsx");
    expect(chooser).toContain(
      '"desktop" | "terminal" | "artifacts" | "agents" | "diff"',
    );
    expect(chooser).toContain('(id === "diff" && !diffAvailable)');
    expect(chooser).not.toContain('if (id !== "diff") onSelect(id)');
  });

  test("the session rail gates the Diff tab on hasFiles and renders DiffPane", () => {
    const sessionView = read("../chat/session-view.tsx");
    expect(sessionView).toContain('value="diff" data-testid="rail-tab-diff"');
    expect(sessionView).toContain("{hasFiles && (");
    expect(sessionView).toContain("diffAvailable={hasFiles}");
    expect(sessionView).toContain("<DiffPane turns={turns} />");
    expect(sessionView).toContain(': railTab === "diff" ?');
  });
});
