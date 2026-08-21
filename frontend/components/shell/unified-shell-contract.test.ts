import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const readFromFrontend = (path: string) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

const shellSources = () => ({
  appShell: read("./app-shell.tsx"),
  compactSidebarRail: read("./compact-sidebar-rail.tsx"),
  librarySidebar: read("./library-sidebar.tsx"),
  searchCommand: read("./search-command.tsx"),
  sidebarBrand: read("./sidebar-brand.tsx"),
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
    const sidebarThreads = read("./sidebar-threads.tsx");
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
      expect(`${threadSidebar}\n${sidebarThreads}`).toContain(label);
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

  test("lets Settings use the full application canvas", () => {
    const settings = readFromFrontend("app/settings/page.tsx");

    expect(settings).toContain('className="w-full min-w-0 px-6 py-8 lg:px-10"');
    expect(settings).not.toContain("max-w-4xl");
    expect(settings).not.toContain("mx-auto w-full");
  });

  test("preserves explicit right-panel surface choices", () => {
    const sessionView = readFromFrontend("components/chat/session-view.tsx");

    expect(sessionView).toContain("const [railTabOverride, setRailTabOverride] = useState<");
    expect(sessionView).toContain('SurfaceChoice | "editor" | "workspace" | null');
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

  test("keeps legacy code and design showcases out of product navigation", () => {
    const { searchCommand } = shellSources();

    expect(searchCommand).not.toContain('href: "/code"');
    expect(searchCommand).not.toContain('href: "/design"');
    expect(existsSync(new URL("../../app/code/page.tsx", import.meta.url))).toBe(false);
    expect(existsSync(new URL("../../app/design/page.tsx", import.meta.url))).toBe(false);
  });

  test("names the optional skill and playbook control when nothing is selected", () => {
    const composer = readFromFrontend("app/agent/new/new-task-composer.tsx");
    const contextMenu = readFromFrontend("app/agent/new/new-task-context-menu.tsx");

    expect(composer).toContain("<NewTaskContextMenu");
    expect(contextMenu).toContain("visibleSkills.map");
    expect(composer).toContain('label: "No skill or playbook"');
  });

  test("keeps context actions expandable and the primary action inline", () => {
    const composer = readFromFrontend("app/agent/new/new-task-composer.tsx");
    const contextMenu = readFromFrontend("app/agent/new/new-task-context-menu.tsx");

    expect(contextMenu).toContain('aria-label="Add files and context"');
    expect(contextMenu).toContain("Add photos &amp; files");
    expect(contextMenu).not.toContain("Company knowledge");
    expect(contextMenu).not.toContain("Personal memory");
    expect(contextMenu).toContain("Type to search skills and playbooks");
    expect(contextMenu).not.toContain("<SearchablePicker");
    expect(composer).toContain("<PromptInput");
    expect(composer).toContain("<PromptInputTextarea");
    expect(composer).not.toContain("<textarea");
    expect(composer).toContain("min-w-32");
    expect(composer).toContain("grid-cols-[minmax(0,1fr)_auto]");
    expect(composer).toContain("flex-nowrap");
    expect(composer).toContain('e.id !== "chat"');
    expect(composer).not.toContain("<AsteriskMark");
    expect(composer).not.toContain("border-t border-stroke-soft-200 pt-3");
  });

  test("folds the project rail to a useful compact rail on a real working transition", () => {
    const { appShell, compactSidebarRail } = shellSources();

    expect(appShell).toContain("useWorkingSignal()");
    expect(appShell).toContain("previousWorking.current");
    expect(appShell).toContain("setSidebarCollapsed(true)");
    expect(appShell).toContain("inert={sidebarCollapsed}");
    expect(appShell).toContain("aria-hidden={sidebarCollapsed}");
    expect(appShell).toContain("<CompactSidebarRail");
    expect(appShell).toContain('sidebarCollapsed ? "w-0" : "w-64"');
    expect(appShell).toContain("sidebarRestoreRef.current?.focus()");
    expect(compactSidebarRail).toContain('aria-label="Expand navigation"');
    expect(compactSidebarRail).toContain("<SearchCommand compact");
    expect(compactSidebarRail).toContain('href="/dashboard"');
    expect(compactSidebarRail).toContain('href="/skills"');
    expect(compactSidebarRail).toContain("<UserMenu");
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

  test("uses the orbit-knot brand mark and animates it only while working", () => {
    const mark = readFromFrontend("components/foundations/brand/orbit-knot-mark.tsx");
    const { sidebarBrand } = shellSources();

    expect(mark).toContain("useId");
    expect(mark).toContain('strokeLinejoin="round"');
    expect(mark).toContain('strokeLinecap="round"');
    expect(mark).toContain("motion-safe:animate-");
    expect(mark).toContain("active &&");
    expect(sidebarBrand).toContain("OrbitKnotMark");
    expect(sidebarBrand).not.toContain("border-b");
  });

  test("gives the reply composer drafting room without a second boxed wrapper", () => {
    const composer = readFromFrontend("components/chat/composer.tsx");
    const conversation = readFromFrontend("components/chat/conversation.tsx");

    expect(composer).toContain("maxHeight={180}");
    expect(composer).toContain(
      'hero ? "pt-1 text-paragraph-lg" : "min-h-12 text-paragraph-sm leading-relaxed"',
    );
    expect(conversation).toContain("mx-auto w-full max-w-5xl");
    expect(conversation).not.toContain("shrink-0 border-t p-3");
  });
});
