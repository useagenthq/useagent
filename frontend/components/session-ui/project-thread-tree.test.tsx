import { expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  type ProjectGroup,
  type ProjectMenuControl,
  type ProjectThread,
  ProjectThreadTree,
  projectThreadTreeIds,
  retainThreadTreeActiveId,
} from "./project-thread-tree";

const thread = (id: string, label: string, over: Partial<ProjectThread> = {}): ProjectThread => ({
  id,
  label,
  time: "2h ago",
  status: "completed",
  ...over,
});

const group = (over: Partial<ProjectGroup> = {}): ProjectGroup => ({
  key: "acme/api",
  label: "api",
  fullName: "acme/api",
  threads: [thread("r1", "Fix the auth bug"), thread("r2", "Add tests", { time: "1d ago" })],
  ...over,
});

function renderTree(
  groups: ProjectGroup[],
  opts: {
    expanded?: boolean;
    renderMenu?: (group: ProjectGroup, control: ProjectMenuControl) => ReactNode;
  } = {},
): string {
  return renderToStaticMarkup(
    <ProjectThreadTree
      groups={groups}
      isExpanded={() => opts.expanded ?? true}
      onToggle={() => {}}
      threadHref={(t) => `/session/${t.id}`}
      renderMenu={opts.renderMenu}
    />,
  );
}

test("children render as indented doc rows without connector lines", () => {
  for (const count of [1, 3, 5]) {
    const threads = Array.from({ length: count }, (_, i) => thread(`r${i}`, `Thread ${i}`));
    const html = renderTree([group({ threads })]);
    // No connector overlay survives; each child is an indented row on the
    // shared uniform height with the one-step indent.
    expect(html).not.toContain("Project thread connector");
    expect(html.match(/data-session-ui="thread-row"/g) ?? []).toHaveLength(count);
    expect(html.match(/h-8 w-full/g) ?? []).toHaveLength(count);
    expect(html.match(/pl-6/g) ?? []).toHaveLength(count);
  }
});

test("a project row toggles expansion while only its threads navigate", () => {
  const expanded = renderTree([group()], { expanded: true });
  // The folder header is a disclosure button (toggles), never a nav link.
  expect(expanded).toContain('aria-expanded="true"');
  expect(expanded).toContain('type="button"');
  // The threads are the only links, each to its session route.
  expect(expanded).toContain('href="/session/r1"');
  expect(expanded).toContain('href="/session/r2"');
  expect(expanded).toContain('data-session-ui="thread-row"');
  expect(expanded).not.toContain('href="/agent'); // the row itself does not navigate

  const collapsed = renderTree([group()], { expanded: false });
  expect(collapsed).toContain('aria-expanded="false"');
  // grid-rows 0fr collapses the thread list height (native animation).
  expect(collapsed).toContain("grid-rows-[0fr]");
  expect(collapsed).toContain('aria-hidden="true"');
  expect(collapsed.match(/role="treeitem"[^>]*tabindex="-1"/g) ?? []).toHaveLength(2);
  expect(collapsed).not.toContain('role="treeitem" tabindex="0"');
});

test("threads show a relative-time chip and mark the active thread", () => {
  const html = renderTree([
    group({
      threads: [
        thread("r1", "Fix the auth bug", { time: "2h ago", isSelected: true }),
        thread("r2", "Add tests", { time: "1d ago" }),
      ],
    }),
  ]);
  expect(html).toContain("2h ago");
  expect(html).toContain("1d ago");
  expect(html).toContain('aria-current="page"'); // the selected thread only
});

test("product children render as nested accessible session links", () => {
  const html = renderTree([
    group({
      threads: [thread("root", "Calendar app", {
        children: [thread("child", "Keyboard design", {
          engine: "codex",
          model: "gpt-5.6-sol",
          isSelected: true,
        })],
      })],
    }),
  ]);
  expect(html).toContain('role="tree"');
  expect(html).toContain('role="group"');
  expect(html).toContain('aria-level="2"');
  expect(html).toContain('href="/session/child"');
  expect(html).toContain('aria-current="page"');
});

test("live child insertion preserves roving focus on the existing selected row", () => {
  const before = [thread("root", "Root", { children: [thread("a", "A")] })];
  const after = [thread("root", "Root", { children: [thread("a", "A"), thread("b", "B")] })];
  expect(projectThreadTreeIds(after)).toEqual(["root", "a", "b"]);
  expect(retainThreadTreeActiveId("a", projectThreadTreeIds(after))).toBe("a");
  expect(retainThreadTreeActiveId("missing", projectThreadTreeIds(before))).toBe("root");
});

test("active statuses render truthful dots with non-color aria labels", () => {
  const html = renderTree([
    group({
      threads: [
        thread("running", "Live thread", { status: "running" }),
        thread("queued", "Waiting thread", { status: "queued" }),
        thread("done", "Finished thread", { status: "completed" }),
        thread("failed", "Broken thread", { status: "failed" }),
      ],
    }),
  ]);
  expect(html).toContain('aria-label="Running"');
  expect(html).toContain('aria-label="Queued"');
  expect(html).toContain('aria-label="Failed"');
  expect(html).not.toContain('aria-label="Completed"');
  expect(html).toContain("bg-lime-500");
  expect(html).toContain("border-orange-500");
});

test("each project shows at most six threads until its own disclosure is expanded", () => {
  const threads = Array.from({ length: 8 }, (_, i) => thread(`r${i}`, `Thread ${i}`));
  const html = renderTree([group({ threads })]);

  expect(html.match(/data-session-ui="thread-row"/g) ?? []).toHaveLength(6);
  expect(html).toContain("Show 2 more");
  expect(html).not.toContain("Thread 6");
});

test("native subagent rows nest under their parent thread as inspect-only links", () => {
  const html = renderTree([
    group({
      threads: [
        thread("r1", "Fix the auth bug", {
          nativeChildren: {
            rows: [
              {
                id: "e1",
                label: "Research checkout",
                state: "running",
                href: "/session/r1?agent_execution=e1&agent_run=run-1",
              },
              {
                id: "e2",
                label: "Subagent",
                state: "failed",
                href: "/session/r1?agent_execution=e2&agent_run=run-1",
              },
            ],
            overflow: 3,
          },
        }),
        thread("r2", "Add tests"),
      ],
    }),
  ]);

  // The nested rows link to the PARENT session with exact execution identity and
  // never register as thread rows; the bound's remainder shows as "+N more".
  expect(html.match(/data-session-ui="native-agent-row"/g) ?? []).toHaveLength(2);
  expect(html.match(/data-session-ui="thread-row"/g) ?? []).toHaveLength(2);
  expect(html).toContain(
    'href="/session/r1?agent_execution=e1&amp;agent_run=run-1"',
  );
  expect(html).toContain(
    'href="/session/r1?agent_execution=e2&amp;agent_run=run-1"',
  );
  expect(html).toContain("Research checkout");
  expect(html).toContain("+3 more");
});

test("each real project gets one shared actions-menu slot; the no-project bucket gets none", () => {
  const groups = [
    group({ key: "acme/api", label: "api", fullName: "acme/api" }),
    group({ key: "__unattached__", label: "No project", fullName: null, threads: [] }),
  ];
  const renderMenu = (g: ProjectGroup, control: ProjectMenuControl) =>
    g.fullName ? <span data-testid="proj-menu" data-open={String(control.isOpen)} /> : null;
  const html = renderTree(groups, { expanded: false, renderMenu });

  // A single menu instance for the real project (opened by its kebab) and none
  // for the no-project bucket.
  const menus = html.match(/data-testid="proj-menu"/g) ?? [];
  expect(menus).toHaveLength(1);
  expect(html).toContain('data-open="false"');
});
