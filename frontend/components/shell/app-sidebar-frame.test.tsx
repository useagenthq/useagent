import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { TooltipProvider } from "@/components/sidebar-kit/tooltip";

let botsEnabled = false;

mock.module("next/navigation", () => ({
  usePathname: () => "/artifacts",
}));

mock.module("@/hooks/use-capability-catalog", () => ({
  useCapabilityCatalog: () => ({ catalog: { bots: botsEnabled }, loaded: true }),
}));

mock.module("@/lib/auth", () => ({
  useSession: () => ({ session: null, loading: false, refresh: () => {} }),
}));

mock.module("./search-command", () => ({
  SearchCommand: ({ compact = false }: { compact?: boolean }) => (
    <button type="button" data-search-compact={compact}>
      Search
    </button>
  ),
}));

mock.module("./sidebar-projects", () => ({
  SidebarProjects: () => <div>Projects</div>,
}));

mock.module("./user-menu", () => ({
  UserMenu: ({ trigger }: { trigger: React.ReactNode }) => trigger,
}));

const { SidebarProvider } = await import("@/components/sidebar-kit/sidebar");
const { AppSidebarFrame, NavRoutes } = await import("./app-sidebar-frame");
const { AppShell } = await import("./app-shell");
const { SidebarThreadsProvider } = await import("./sidebar-threads-provider");
const { ThreadSidebar } = await import("./thread-sidebar");

function renderCollapsed(node: React.ReactNode): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <SidebarThreadsProvider>
        <SidebarProvider defaultOpen={false}>{node}</SidebarProvider>
      </SidebarThreadsProvider>
    </TooltipProvider>,
  );
}

describe("collapsed application sidebar", () => {
  test("keeps search mounted and turns routes with subroutes into labelled current-page links", () => {
    const routes = [
      {
        id: "library",
        title: "Library",
        icon: <span aria-hidden>icon</span>,
        href: "/artifacts",
        active: true,
        subs: [{ title: "Artifacts", href: "/artifacts" }],
      },
    ];

    const navHtml = renderCollapsed(<NavRoutes routes={routes} />);
    expect(navHtml).toContain('href="/artifacts"');
    expect(navHtml).toContain('aria-label="Library"');
    expect(navHtml).toContain('aria-current="page"');

    const frameHtml = renderCollapsed(<AppSidebarFrame>Navigation</AppSidebarFrame>);
    expect(frameHtml).toContain('data-search-compact="true"');
  });

  test("exposes Bots only when the authenticated capability catalog enables it", () => {
    botsEnabled = false;
    expect(renderCollapsed(<ThreadSidebar active="bots" />)).not.toContain('href="/bots"');

    botsEnabled = true;
    const html = renderCollapsed(<ThreadSidebar active="bots" />);
    expect(html).toContain('href="/bots"');
    expect(html).toContain('aria-label="Bots"');
    expect(html).toContain('aria-current="page"');
  });

  test("uses one main landmark for the bounded page scroll area", () => {
    const html = renderToStaticMarkup(
      <AppShell sidebar={<aside>Navigation</aside>}>Page</AppShell>,
    );

    expect(html.match(/<main(?:\s|>)/g)).toHaveLength(1);
    expect(html).toContain('<div data-slot="sidebar-inset"');
    expect(html).toContain('<main id="main-content"');
  });
});
