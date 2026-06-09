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

    expect(appShell).toContain("h-dvh w-full overflow-hidden bg-background-full");
    expect(appShell).not.toContain("p-2");
    expect(appShell).not.toContain("sm:p-3");
    expect(appShell).not.toContain("rounded-2xl");
    expect(appShell).not.toContain("shadow-regular");
  });

  test("limits primary sidebar navigation to projects, threads, usage, customize, and settings", () => {
    const { threadSidebar } = shellSources();
    const projectTree = read("../session-ui/project-thread-tree.tsx");
    const primaryDestinations = ["Dashboard", "Threads", "Usage", "Customize", "Settings"];
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
      expect(`${threadSidebar}\n${projectTree}`).toContain(label);
    }
    for (const label of displacedDestinations) {
      expect(threadSidebar).not.toContain(`label='${label}'`);
    }
    expect(threadSidebar).not.toContain('label="All projects"');
    expect(threadSidebar.match(/href="\/dashboard"/g)).toHaveLength(1);
  });

  test("groups all library surfaces under Customize", () => {
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

    expect(threadSidebar).toContain('label="Customize"');
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
    for (const tab of ["agents", "artifacts", "editor", "terminal", "desktop"]) {
      expect(sessionView).toContain(`data-testid="rail-tab-${tab}"`);
      expect(sessionView).toContain(`isSelected={railTab === "${tab}"}`);
      expect(sessionView).toContain(`onSelect={() => setRailTabOverride("${tab}")}`);
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
    // The per-project actions menu owns the "start a thread in this repo" route.
    const projectMenu = read("./sidebar-project-menu.tsx");
    const composer = readFromFrontend("app/agent/new/new-task-composer.tsx");

    expect(projects).toContain('backendFetch("/api/repos"');
    expect(projectMenu).toContain("encodeURIComponent(group.fullName");
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

    expect(composer).toContain('triggerLabel="Playbook or skills"');
    expect(composer).toContain('label: "Playbook or skills"');
  });

  test("keeps context actions expandable and the primary action inline", () => {
    const composer = readFromFrontend("app/agent/new/new-task-composer.tsx");
    const newThreadPage = readFromFrontend("app/agent/new/page.tsx");
    // The add-context rows (upload, Create, GitHub) live in a shared module
    // consumed by BOTH the new-thread shelf and the reply composer popover.
    const addMenu = readFromFrontend("components/chat/composer-add-menu.tsx");

    expect(composer).toContain('aria-label="Add context"');
    expect(addMenu).toContain("Add photos &amp; files");
    expect(addMenu).toContain("GitHub");
    expect(composer).toContain("<AddFilesRow");
    expect(composer).toContain("<GithubConnectedRow");
    // Repository selection is the single "Choose project" entry in the notch
    // below the card (not a row in the "+" menu).
    expect(composer).toContain('emptyLabel="Choose project"');
    expect(composer).toContain("<PromptInput");
    expect(composer).toContain("<PromptInputTextarea");
    expect(composer).not.toContain("<textarea");
    expect(composer).toContain("Start thread");
    expect(composer).toContain("flex-nowrap");
    expect(composer).toContain("overflow-hidden");
    // Model rides the compact engine + model chip.
    expect(composer).toContain('ariaLabel="Select model"');
    expect(newThreadPage).toContain("max-w-3xl");
    expect(composer).toContain('e.id !== "chat"');
    expect(composer).not.toContain("<AsteriskMark");
  });

  test("shares the same add-context grammar in the reply composer", () => {
    const replyComposer = readFromFrontend("components/chat/composer.tsx");
    // The reply "+" opens the SHARED add-menu rows (real upload + Create seeds)
    // in a popover above the input, instead of jumping straight to the file
    // dialog. Repos/GitHub are omitted - a reply reuses the thread's sandbox.
    expect(replyComposer).toContain('from "@/components/chat/composer-add-menu"');
    expect(replyComposer).toContain("<AddFilesRow");
    expect(replyComposer).toContain("<CreateRows");
    expect(replyComposer).toContain('aria-label="Add context"');
    expect(replyComposer).toContain("setAddMenuOpen");
    expect(replyComposer).not.toContain('aria-label="Add files"');
  });

  test("folds the project rail to a useful compact rail on a real working transition", () => {
    const { appShell, compactSidebarRail } = shellSources();
    const threadLayout = readFromFrontend("app/session/(thread)/layout.tsx");

    expect(appShell).toContain("useWorkingSignal()");
    expect(appShell).toContain("previousWorking.current");
    // The session route explicitly opts into the tablet fold; library and
    // settings consumers of AppShell do not inherit session layout policy.
    expect(appShell).toContain("useIsTabletBand()");
    expect(appShell).toContain("previousBand.current");
    expect(appShell).toContain("collapseSidebarAtTablet && tabletBand");
    expect(threadLayout).toContain("collapseSidebarAtTablet");
    expect(appShell).toContain("setSidebarCollapsed(true)");
    expect(appShell).toContain("inert={sidebarCollapsed}");
    expect(appShell).toContain("aria-hidden={sidebarCollapsed}");
    expect(appShell).toContain("<CompactSidebarRail");
    expect(appShell).toContain('sidebarCollapsed ? "w-0" : "w-64"');
    expect(appShell).toContain("sidebarRestoreRef.current?.focus()");
    expect(compactSidebarRail).toContain('aria-label="Expand navigation"');
    expect(compactSidebarRail).toContain("<SearchCommand compact");
    expect(compactSidebarRail).toContain('href="/dashboard"');
    expect(compactSidebarRail).toContain('label="Dashboard"');
    expect(compactSidebarRail).not.toContain('label="All projects"');
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

    expect(mark).toContain('viewBox="0 0 300 300"');
    expect(mark).toContain("M 150.00 51.00 C 176.40 51.00");
    expect(mark).toContain("useId");
    expect(mark).toContain("linearGradient");
    expect(mark).toContain("#6DD5FA");
    expect(mark).toContain("#20A9F5");
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
    const promptInput = readFromFrontend("components/prompt-kit/prompt-input.tsx");

    expect(composer).toContain("maxHeight={180}");
    expect(composer).toContain(
      '"grid h-fit grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-1 p-2"',
    );
    expect(composer).toContain(
      'hero ? "pt-1 text-headline-regular" : "min-h-6 text-body-2-regular leading-6"',
    );
    expect(promptInput).toContain('el.style.height = "0px"');
    expect(promptInput).not.toContain('el.style.height = "auto"');
    expect(conversation).toContain("flex min-h-0 flex-1 flex-col overflow-hidden");
    expect(conversation).toContain("mx-auto w-full max-w-5xl");
    expect(conversation).not.toContain("shrink-0 border-t p-3");
  });
});
