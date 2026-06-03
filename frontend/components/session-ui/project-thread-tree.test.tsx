import { expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  type ProjectGroup,
  type ProjectMenuControl,
  type ProjectThread,
  ProjectThreadTree,
} from "./project-thread-tree";

const thread = (id: string, label: string, over: Partial<ProjectThread> = {}): ProjectThread => ({
  id,
  label,
  time: "2h ago",
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

test("the curved tree connector draws exactly one elbow per thread", () => {
  for (const count of [1, 3, 5]) {
    const threads = Array.from({ length: count }, (_, i) => thread(`r${i}`, `Thread ${i}`));
    const html = renderTree([group({ threads })]);
    // Connector paths carry the signature "M0.5 0 V…" elbow, distinct from the
    // folder icon's own svg path — one per thread.
    const elbows = html.match(/M0\.5 0 V/g) ?? [];
    expect(elbows).toHaveLength(count);
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

test("each project shows at most six threads until its own disclosure is expanded", () => {
  const threads = Array.from({ length: 8 }, (_, i) => thread(`r${i}`, `Thread ${i}`));
  const html = renderTree([group({ threads })]);

  expect(html.match(/data-session-ui="thread-row"/g) ?? []).toHaveLength(6);
  expect(html).toContain("Show 2 more");
  expect(html).not.toContain("Thread 6");
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
