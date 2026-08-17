import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const readFromFrontend = (path: string) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

const shellSources = () => ({
  appShell: read('./app-shell.tsx'),
  librarySidebar: read('./library-sidebar.tsx'),
  searchCommand: read('./search-command.tsx'),
  threadSidebar: read('./thread-sidebar.tsx'),
  topNav: read('./top-nav.tsx'),
});

describe('unified shell contract', () => {
  test('does not split Chat and Agent into top-navigation tabs', () => {
    const { topNav } = shellSources();

    expect(topNav).not.toContain("label: 'Chat'");
    expect(topNav).not.toContain("label: 'Agent'");
    expect(topNav).not.toContain("id: 'chat'");
    expect(topNav).not.toContain("id: 'agent'");
  });

  test('renders the application shell full-bleed without an outer rounded card', () => {
    const { appShell } = shellSources();

    expect(appShell).toContain('className="h-dvh w-full bg-bg-white-0"');
    expect(appShell).not.toContain('p-2');
    expect(appShell).not.toContain('sm:p-3');
    expect(appShell).not.toContain('rounded-2xl');
    expect(appShell).not.toContain('shadow-regular');
  });

  test('limits primary sidebar navigation to projects, threads, usage, library, and settings', () => {
    const { threadSidebar } = shellSources();
    const sidebarRecents = read('./sidebar-recents.tsx');
    const primaryDestinations = ['All projects', 'Threads', 'Usage', 'Library', 'Settings'];
    const displacedDestinations = [
      'New chat',
      'New task',
      'Workspace',
      'Active runs',
      'Live Artifacts',
      'Automations',
      'Plugins',
      'Knowledge',
      'Memory',
      'Wiki',
      'Skills',
      'Playbooks',
      'Artifacts',
      'Apps',
    ];

    for (const label of primaryDestinations) {
      expect(`${threadSidebar}\n${sidebarRecents}`).toContain(label);
    }
    for (const label of displacedDestinations) {
      expect(threadSidebar).not.toContain(`label='${label}'`);
    }
  });

  test('groups all library surfaces under Library', () => {
    const { librarySidebar, threadSidebar } = shellSources();
    const librarySurfaces = [
      'Skills',
      'Playbooks',
      'Automations',
      'Knowledge',
      'Wiki',
      'Apps',
      'Artifacts',
      'Secrets',
    ];

    expect(threadSidebar).toContain(`label='Library'`);
    for (const label of librarySurfaces) {
      expect(librarySidebar).toContain(`label: '${label}'`);
    }
  });

  test('preserves explicit right-panel surface choices', () => {
    const sessionView = readFromFrontend('components/chat/session-view.tsx');

    expect(sessionView).toContain('const [railTabOverride, setRailTabOverride] = useState<');
    expect(sessionView).toContain('"agents" | "artifacts" | "editor" | "terminal" | "desktop" | null');
    expect(sessionView).toContain('value={railTab}');
    for (const tab of ['agents', 'artifacts', 'editor', 'terminal', 'desktop']) {
      expect(sessionView).toContain(`value="${tab}" data-testid="rail-tab-${tab}"`);
    }
  });

  test('relies on authenticated shell paths instead of preview or auth-bypass mocks', () => {
    const desktopPane = readFromFrontend('components/chat/desktop-pane.tsx');
    const sessionView = readFromFrontend('components/chat/session-view.tsx');
    const proxy = readFromFrontend('proxy.ts');
    const shellAndDesktop = `${Object.values(shellSources()).join('\n')}\n${desktopPane}\n${sessionView}`;

    expect(desktopPane).toContain('/api/desktop-proxy/');
    expect(proxy).toContain("NextResponse.redirect(new URL('/login', request.url))");
    expect(shellAndDesktop).not.toContain('auth-bypass');
    expect(shellAndDesktop).not.toContain('authBypass');
    expect(shellAndDesktop).not.toContain('/preview/');
    expect(shellAndDesktop).not.toContain('preview_url');
    expect(shellAndDesktop).not.toContain('previewUrl');
  });

  test('routes the product home into the durable unified thread composer', () => {
    const home = readFromFrontend('app/page.tsx');

    expect(home).toContain('redirect("/agent/new")');
    expect(home).not.toContain('ChatView');
  });

  test('does not offer sandbox runtime surfaces on direct Chat threads', () => {
    const sessionView = readFromFrontend('components/chat/session-view.tsx');

    expect(sessionView).toContain(
      'const hasRuntimeSurfaces = normalizeEngine(newest.engine) !== "chat"',
    );
    expect(sessionView).toContain('const railOpen = railOverride ?? hasRuntimeSurfaces');
  });

  test('uses authenticated repository data for project shortcuts', () => {
    const projects = read('./sidebar-projects.tsx');
    const composer = readFromFrontend('app/agent/new/new-task-composer.tsx');

    expect(projects).toContain('backendFetch("/api/repos"');
    expect(projects).toContain('encodeURIComponent(project.fullName)');
    expect(composer).toContain('initialRepository');
    expect(projects).not.toContain('Growth Campaign');
    expect(projects).not.toContain('Content Engine');
  });
});
