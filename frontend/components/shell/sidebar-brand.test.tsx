import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SidebarBrand } from "./sidebar-brand";

test("renders the useAgent wordmark and accessible new-thread label by default", () => {
  const html = renderToStaticMarkup(<SidebarBrand />);

  expect(html).toContain(">useAgent<");
  expect(html).toContain('aria-label="useAgent new thread"');
  expect(html).toContain('href="/agent/new"');
});

test("keeps the accessible brand label when the visible label is contextual", () => {
  const html = renderToStaticMarkup(<SidebarBrand label="Library" />);

  expect(html).toContain(">Library<");
  expect(html).toContain('aria-label="useAgent new thread"');
});
