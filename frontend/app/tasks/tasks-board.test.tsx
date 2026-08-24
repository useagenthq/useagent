import { expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

// The board reads the URL via next/navigation; stub the hooks so the static
// render is deterministic (no App Router context under renderToStaticMarkup).
mock.module("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {}, refresh: () => {} }),
  usePathname: () => "/tasks",
  useSearchParams: () => new URLSearchParams(),
}));

const { TasksBoard } = await import("./tasks-board");

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
