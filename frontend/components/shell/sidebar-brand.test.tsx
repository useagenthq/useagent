import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SidebarBrand } from "./sidebar-brand";

test("renders the UseAgent wordmark and accessible new-thread label by default", () => {
  const html = renderToStaticMarkup(<SidebarBrand />);

  expect(html).toContain(">UseAgent<");
  expect(html).toContain('aria-label="UseAgent new thread"');
  expect(html).toContain('href="/agent/new"');
  expect(html).toContain("size-8");
});

test("keeps the accessible brand label when the visible label is contextual", () => {
  const html = renderToStaticMarkup(<SidebarBrand label="Library" />);

  expect(html).toContain(">Library<");
  expect(html).toContain('aria-label="UseAgent new thread"');
});
