import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ProjectThreadGroup } from "./sidebar-threads";
import type { ProjectGroup } from "./sidebar-project-groups";
import type { SidebarRun } from "./working-project-status";

function thread(id: string, prompt: string, overrides: Partial<SidebarRun> = {}): SidebarRun {
  return {
    id,
    prompt,
    model: "claude-sonnet-5",
    engine: "opencode",
    status: "completed",
    summary: null,
    duration_ms: null,
    repo: "acme/api",
    repos: ["acme/api"],
    repo_specs: [{ repo: "acme/api", branch: null }],
    created_at: "2026-08-24T10:00:00Z",
    updated_at: "2026-08-24T10:00:00Z",
    ...overrides,
  } as SidebarRun;
}

const group = (overrides: Partial<ProjectGroup> = {}): ProjectGroup => ({
  key: "acme/api",
  name: "api",
  fullName: "acme/api",
  threads: [thread("r1", "Fix the auth bug")],
  ...overrides,
});

test("an expanded group nests its threads under a connecting tree line", () => {
  const html = renderToStaticMarkup(
    <ProjectThreadGroup group={group()} expanded onToggle={() => {}} />,
  );

  // Folder header names the repo and is an expanded disclosure.
  expect(html).toContain('aria-expanded="true"');
  expect(html).toContain(">api<");
  // The nested list carries the tree connector line + an accessible label.
  expect(html).toContain('aria-label="Threads in api"');
  expect(html).toContain("border-l");
  // The thread renders through the shared t3 row (title, no repo chip).
  expect(html).toContain("Fix the auth bug");
  expect(html).toContain('data-session-ui="thread-row"');
  expect(html).not.toContain('data-session-ui="git-chips"');
  // A per-repo "start a thread" link points at the composer for this repo.
  expect(html).toContain('href="/agent/new?repo=acme%2Fapi"');
  expect(html).toContain('aria-label="New thread in api"');
});

test("a collapsed group hides its threads", () => {
  const html = renderToStaticMarkup(
    <ProjectThreadGroup group={group()} expanded={false} onToggle={() => {}} />,
  );

  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toContain("Fix the auth bug");
  expect(html).not.toContain('aria-label="Threads in api"');
});

test("caps the nested list and offers a Show N more disclosure", () => {
  const threads = Array.from({ length: 9 }, (_, i) => thread(`r${i}`, `Thread ${i}`));
  const html = renderToStaticMarkup(
    <ProjectThreadGroup group={group({ threads })} expanded onToggle={() => {}} />,
  );

  expect(html).toContain("Thread 0");
  expect(html).toContain("Thread 5");
  // The 7th+ thread sits behind the disclosure (6 visible).
  expect(html).not.toContain("Thread 6");
  expect(html).toContain("Show 3 more");
});

test("a zero-thread repo renders as a plain shortcut to start a thread", () => {
  const html = renderToStaticMarkup(
    <ProjectThreadGroup
      group={group({ name: "web", fullName: "acme/web", key: "acme/web", threads: [] })}
      expanded={false}
      onToggle={() => {}}
    />,
  );

  expect(html).toContain('href="/agent/new?repo=acme%2Fweb"');
  expect(html).toContain(">web<");
  expect(html).not.toContain("aria-expanded");
});
