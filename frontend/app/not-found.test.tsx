import { expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

// The shell's sidebar reads the URL via next/navigation; stub the hooks so the
// static render has no app router to mount (same shape as tasks-board.test).
mock.module("next/navigation", () => ({
  useRouter: () => ({ push() {}, replace() {}, refresh() {}, prefetch() {} }),
  usePathname: () => "/this-route-does-not-exist",
  useSearchParams: () => new URLSearchParams(),
}));

const { default: NotFound } = await import("./not-found");

test("the 404 page renders inside the app shell with a way forward", () => {
  const html = renderToStaticMarkup(<NotFound />);
  expect(html).toContain("Page not found");
  expect(html).toContain('href="/agent/new"');
  expect(html).toContain("Go to new thread");
  // Composed with the shell, not Next's bare page.
  expect(html).toContain('data-testid="primary-sidebar-shell"');
  expect(html).toContain("<main");
});
