import { describe, expect, test } from "bun:test";
import { RiBook3Line } from "@remixicon/react";
import {
  AppRouterContext,
  type AppRouterInstance,
} from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SidebarProvider } from "@/components/sidebar-kit/sidebar";
import { TooltipProvider } from "@/components/sidebar-kit/tooltip";
import { AppShell } from "./app-shell";
import { AppSidebarFrame, NavRoutes } from "./app-sidebar-frame";
import { SidebarThreadsProvider } from "./sidebar-threads-provider";
import { ThreadSidebar } from "./thread-sidebar";

const router = {
  push() {},
  replace() {},
  refresh() {},
  back() {},
  forward() {},
  prefetch() {},
} as unknown as AppRouterInstance;

function renderCollapsed(node: ReactNode): string {
  return renderToStaticMarkup(
    <AppRouterContext.Provider value={router}>
      <PathnameContext.Provider value="/artifacts">
        <TooltipProvider>
          <SidebarThreadsProvider>
            <SidebarProvider defaultOpen={false}>{node}</SidebarProvider>
          </SidebarThreadsProvider>
        </TooltipProvider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>,
  );
}

describe("collapsed application sidebar", () => {
  test("keeps real search mounted and grouped routes labelled and navigable", () => {
    const routes = [
      {
        id: "library",
        title: "Library",
        icon: RiBook3Line,
        href: "/artifacts",
        active: true,
        subs: [{ title: "Artifacts", href: "/artifacts", icon: RiBook3Line }],
      },
    ];
    const navHtml = renderCollapsed(<NavRoutes routes={routes} />);
    expect(navHtml).toContain('href="/artifacts"');
    expect(navHtml).toContain('aria-label="Library"');
    expect(navHtml).toContain('aria-current="page"');
    const frameHtml = renderCollapsed(<AppSidebarFrame>Navigation</AppSidebarFrame>);
    expect(frameHtml).toContain('aria-label="Search"');
    expect(frameHtml).toContain('aria-label="Open account menu"');
  });

  test("does not advertise Bots before the capability catalog loads", () => {
    expect(renderCollapsed(<ThreadSidebar active="bots" />)).not.toContain('href="/bots"');
  });

  test("uses one main landmark for the bounded page scroll area", () => {
    const html = renderCollapsed(<AppShell sidebar={<aside>Navigation</aside>}>Page</AppShell>);
    expect(html.match(/<main(?:\s|>)/g)).toHaveLength(1);
    expect(html).toContain('<div data-slot="sidebar-inset"');
    expect(html).toContain('<main id="main-content"');
  });
});
