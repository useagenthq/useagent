import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const readFromFrontend = (path: string) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

const shellSources = () => ({
  appShell: read("./app-shell.tsx"),
  librarySidebar: read("./library-sidebar.tsx"),
  searchCommand: read("./search-command.tsx"),
  threadSidebar: read("./thread-sidebar.tsx"),
});

describe("unified shell contract", () => {
  test("does not split Chat and Agent into top-navigation tabs", () => {
    const { appShell } = shellSources();

    expect(appShell).not.toContain("TopNav");
    expect(appShell).not.toContain("label: 'Chat'");
    expect(appShell).not.toContain("label: 'Agent'");
  });

  test("renders the application shell full-bleed without an outer rounded card", () => {
    const { appShell } = shellSources();

    expect(appShell).toContain("h-dvh w-full overflow-hidden bg-bg-white-0");
    expect(appShell).not.toContain("p-2");
    expect(appShell).not.toContain("sm:p-3");
    expect(appShell).not.toContain("rounded-2xl");
    expect(appShell).not.toContain("shadow-regular");
  });

  test("limits primary sidebar navigation to projects, threads, usage, library, and settings", () => {
    const { threadSidebar } = shellSources();
    const sidebarRecents = read("./sidebar-recents.tsx");
    const primaryDestinations = ["All projects", "Threads", "Usage", "Library", "Settings"];
    const displacedDestinations = [
      "New chat",
      "New task",
      "Workspace",
      "Active runs",
      "Live Artifacts",
      "Automations",
      "Plugins",
      "Knowledge",
      "Memory",
      "Wiki",
      "Skills",
      "Playbooks",
      "Artifacts",
      "Apps",
    ];

    for (const label of primaryDestinations) {
      expect(`${threadSidebar}\n${sidebarRecents}`).toContain(label);
    }
    for (const label of displacedDestinations) {
      expect(threadSidebar).not.toContain(`label='${label}'`);
    }
  });

  test("groups all library surfaces under Library", () => {
    const { librarySidebar, threadSidebar } = shellSources();
    const librarySurfaces = [
      "Skills",
      "Playbooks",
      "Automations",
      "Knowledge",
      "Wiki",
      "Apps",
      "Artifacts",
      "Secrets",
    ];

    expect(threadSidebar).toContain('label="Library"');
    for (const label of librarySurfaces) {
      expect(librarySidebar).toContain(`label: "${label}"`);
    }
  });

  test("preserves explicit right-panel surface choices", () => {
    const sessionView = readFromFrontend("components/chat/session-view.tsx");

    expect(sessionView).toContain("const [railTabOverride, setRailTabOverride] = useState<");
    expect(sessionView).toContain('SurfaceChoice | "editor" | null');
    expect(sessionView).toContain('value={railTab ?? ""}');
    for (const tab of ["agents", "artifacts", "editor", "terminal", "desktop"]) {
      expect(sessionView).toContain(`value="${tab}" data-testid="rail-tab-${tab}"`);
    }
  });

  test("relies on authenticated shell paths instead of preview or auth-bypass mocks", () => {
    const desktopPane = readFromFrontend("components/chat/desktop-pane.tsx");
    const sessionView = readFromFrontend("components/chat/session-view.tsx");
    const proxy = readFromFrontend("proxy.ts");
    const shellAndDesktop = `${Object.values(shellSources()).join("\n")}\n${desktopPane}\n${sessionView}`;

    expect(desktopPane).toContain("/api/desktop-proxy/");
    expect(proxy).toContain("NextResponse.redirect(new URL('/login', request.url))");
    expect(shellAndDesktop).not.toContain("auth-bypass");
    expect(shellAndDesktop).not.toContain("authBypass");
    expect(shellAndDesktop).not.toContain("/preview/");
    expect(shellAndDesktop).not.toContain("preview_url");
    expect(shellAndDesktop).not.toContain("previewUrl");
  });

  test("routes the product home into the durable unified thread composer", () => {
    const home = readFromFrontend("app/page.tsx");

    expect(home).toContain('redirect("/agent/new")');
    expect(home).not.toContain("ChatView");
  });

  test("does not offer sandbox runtime surfaces on direct Chat threads", () => {
    const sessionView = readFromFrontend("components/chat/session-view.tsx");

    expect(sessionView).toContain(
      'const hasRuntimeSurfaces = normalizeEngine(newest.engine) !== "chat"',
    );
    expect(sessionView).toContain("const railOpen = railOverride ?? hasRuntimeSurfaces");
  });

  test("uses authenticated repository data for project shortcuts", () => {
    const projects = read("./sidebar-projects.tsx");
    const composer = readFromFrontend("app/agent/new/new-task-composer.tsx");

    expect(projects).toContain('backendFetch("/api/repos"');
    expect(projects).toContain("encodeURIComponent(project.fullName)");
    expect(composer).toContain("initialRepository");
    expect(projects).not.toContain("Growth Campaign");
    expect(projects).not.toContain("Content Engine");
  });

  test("owns brand and search inside the sidebar instead of a global header", () => {
    const { appShell, librarySidebar, searchCommand, threadSidebar } = shellSources();

    expect(appShell).not.toContain("<TopNav");
    expect(threadSidebar).toContain("<SidebarBrand");
    expect(threadSidebar).toContain("<SearchCommand");
    expect(librarySidebar).toContain("<SidebarBrand");
    expect(librarySidebar).toContain("<SearchCommand");
    expect(searchCommand).not.toContain('variant === "top"');
  });

  test("folds the project rail on a real working transition and keeps a restore control", () => {
    const { appShell } = shellSources();

    expect(appShell).toContain("useWorkingSignal()");
    expect(appShell).toContain("previousWorking.current");
    expect(appShell).toContain("setSidebarCollapsed(true)");
    expect(appShell).toContain("inert={sidebarCollapsed}");
    expect(appShell).toContain("aria-hidden={sidebarCollapsed}");
    expect(appShell).toContain("pointer-events-none w-0");
    expect(appShell).toContain("sidebarRestoreRef.current?.focus()");
    expect(appShell).toContain(
      'aria-label={sidebarCollapsed ? "Open navigation" : "Collapse navigation"}',
    );
  });

  test("keeps navigation, search, theme, and account reachable on mobile", () => {
    const { appShell, threadSidebar } = shellSources();

    expect(appShell).toContain('aria-label="Open navigation"');
    expect(appShell).toContain('aria-label="Close navigation"');
    expect(appShell).toContain("mobileOpen ? (");
    expect(threadSidebar).toContain("<SearchCommand");
    expect(threadSidebar).toContain("<ThemeToggle");
    expect(threadSidebar).toContain("<UserMenu");
  });

  test("provides a direct Open a surface chooser for the right inspector", () => {
    const sessionView = readFromFrontend("components/chat/session-view.tsx");
    const chooser = readFromFrontend("components/chat/surface-chooser.tsx");

    expect(sessionView).toContain("<SurfaceChooser");
    expect(chooser).toContain("Open a surface");
    for (const label of ["Browser", "Terminal", "Files", "Diff", "Agents"]) {
      expect(chooser).toContain(label);
    }
  });

  test("uses the cyan orbit brand mark and animates it only while working", () => {
    const mark = readFromFrontend("components/foundations/brand/pulse-mark.tsx");

    expect(mark).toContain("<ellipse");
    expect(mark).toContain("skynet-orbit-active");
    expect(mark).toContain("active &&");
  });
});
