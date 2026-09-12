import { expect, test } from "bun:test";
import {
  AppRouterContext,
  type AppRouterInstance,
} from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import NotFound from "./not-found";

const router = {
  push() {},
  replace() {},
  refresh() {},
  back() {},
  forward() {},
  prefetch() {},
} as unknown as AppRouterInstance;

test("the 404 page renders inside the app shell with a way forward", () => {
  const html = renderToStaticMarkup(
    <AppRouterContext.Provider value={router}>
      <PathnameContext.Provider value="/this-route-does-not-exist">
        <NotFound />
      </PathnameContext.Provider>
    </AppRouterContext.Provider>,
  );
  expect(html).toContain("Page not found");
  expect(html).toContain('href="/agent/new"');
  expect(html).toContain("Go to new thread");
  expect(html).toContain('data-slot="sidebar-wrapper"');
  expect(html).toContain('id="main-content"');
  expect(html.match(/<main(?:\s|>)/g)).toHaveLength(1);
});
