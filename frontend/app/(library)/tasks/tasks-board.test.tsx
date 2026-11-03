import { afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

if (typeof window === "undefined") GlobalRegistrator.register();

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The board reads the URL via next/navigation; stub the hooks so the static
// render is deterministic (no App Router context under renderToStaticMarkup).
mock.module("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {}, refresh: () => {} }),
  usePathname: () => "/tasks",
  useSearchParams: () => new URLSearchParams(),
}));

const { TasksBoard } = await import("./tasks-board");

let root: Root | null = null;
let container: HTMLElement | null = null;
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

test("a ?project= deep-link preselects that project in the filter", () => {
  const html = renderToStaticMarkup(
    <TasksBoard initial={[]} initialRepos={["acme/api", "zeta/app"]} initialProject="acme/api" />,
  );
  // The controlled select marks the deep-linked project as the selected option.
  expect(html).toContain('value="acme/api" selected=""');
  // ...and NOT the "All projects" default.
  expect(html).not.toContain('value="__all__" selected=""');
});

test("no ?project= param defaults the filter to All projects", () => {
  const html = renderToStaticMarkup(
    <TasksBoard initial={[]} initialRepos={["acme/api"]} initialProject={undefined} />,
  );
  expect(html).toContain('value="__all__" selected=""');
  expect(html).not.toContain('value="acme/api" selected=""');
});

test("a deep-linked project with no tasks and absent from repos is still selectable", () => {
  const html = renderToStaticMarkup(
    <TasksBoard initial={[]} initialRepos={["acme/api"]} initialProject="ghost/repo" />,
  );
  // The scope is unioned into the options, so the select renders + preselects it.
  expect(html).toContain('value="ghost/repo" selected=""');
});

test("each card's status control preselects the task's status", () => {
  const task = {
    id: "t1",
    project_key: "acme/api",
    title: "Ship it",
    body: null,
    status: "in_progress" as const,
    priority: 0,
    order: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
  const html = renderToStaticMarkup(
    <TasksBoard initial={[task]} initialRepos={["acme/api"]} initialProject={undefined} />,
  );
  expect(html).toContain('aria-label="Task status"');
  expect(html).toContain('value="in_progress" selected=""');
});

test("Try again reloads tasks in place and clears the error when the service recovers", async () => {
  const task = {
    id: "t1",
    project_key: "acme/api",
    title: "Recovered task",
    body: null,
    status: "todo" as const,
    priority: 0,
    order: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requests.push(String(input));
    return Response.json({ tasks: [task] });
  }) as typeof fetch;

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<TasksBoard initialError />);
  });

  expect(container.textContent).toContain("Could not reach the task service.");
  const retry = Array.from(container.querySelectorAll("button")).find((button) =>
    button.textContent?.includes("Try again"),
  );
  expect(retry).toBeDefined();

  await act(async () => {
    retry?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });

  expect(requests).toEqual(["/api/tasks?scope=all"]);
  expect(container.textContent).toContain("Recovered task");
  expect(container.textContent).not.toContain("Could not reach the task service.");
});
