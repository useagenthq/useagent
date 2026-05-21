import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import * as Tooltip from "@/components/ui/tooltip";
import { type T3ChangedFile } from "./changed-files";
import { T3ChangedFilesCard, T3ChangedFilesTree } from "./changed-files-tree";

const FILES: T3ChangedFile[] = [
  { path: "backend/src/gateway/routes.ts", kind: "edit", additions: 6, deletions: 3 },
  { path: "backend/src/gateway/retry.ts", kind: "edit", additions: 3, deletions: 2 },
  { path: "frontend/app/page.tsx", kind: "edit" },
  { path: "README.md", kind: "add", additions: 2, deletions: 0 },
];

function render(ui: React.ReactElement): string {
  return renderToStaticMarkup(<Tooltip.Provider>{ui}</Tooltip.Provider>);
}

test("expanded card shows the summary header and the compacted tree", () => {
  const html = render(<T3ChangedFilesCard files={FILES} defaultExpanded onOpenFile={() => {}} />);
  expect(html).toContain('data-t3-ui="changed-files-card"');
  expect(html).toContain('data-changed-files-state="expanded"');
  expect(html).toContain("4 changed files");
  // Turn aggregate stat: 11 additions, 5 deletions.
  expect(html).toContain('aria-label="11 additions, 5 deletions"');
  expect(html).toContain("Hide files");
  // Single-child directory chains compact into one row label.
  expect(html).toContain('data-t3-ui="changed-files-tree"');
  expect(html).toContain("backend/src/gateway");
  expect(html).toContain("routes.ts");
  expect(html).toContain("retry.ts");
  expect(html).toContain('aria-label="6 additions, 3 deletions"');
  // Expanded chrome: folder toggle + the diff affordance.
  expect(html).toContain('aria-label="Collapse all folders"');
  expect(html).toContain("Open diff");
});

test("collapsed card renders the compact scope preview instead of the tree", () => {
  const html = render(<T3ChangedFilesCard files={FILES} />);
  expect(html).toContain('data-changed-files-state="preview"');
  expect(html).toContain("Show files");
  // Scope summary: backend 2 files, then frontend and root 1 file each.
  expect(html).toContain("backend");
  expect(html).toContain("2 files");
  expect(html).toContain("Show all 4 files");
  expect(html).not.toContain('data-t3-ui="changed-files-tree"');
  // No onOpenFile callback: the Open-diff affordance stays hidden.
  expect(html).not.toContain("Open diff");
});

test("empty aggregate renders nothing", () => {
  expect(render(<T3ChangedFilesCard files={[]} />)).toBe("");
});

test("bare tree renders stat-less files without a fabricated 0/0 label", () => {
  const html = render(<T3ChangedFilesTree files={[{ path: "frontend/app/page.tsx" }]} />);
  expect(html).toContain("page.tsx");
  expect(html).not.toContain("additions");
});
