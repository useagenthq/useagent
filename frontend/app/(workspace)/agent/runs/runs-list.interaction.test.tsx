// All threads past the first page: mounted under happy-dom with a stubbed
// fetch. "Show older threads" asks for the page after the cursor, appends it
// and moves to the first page that holds it; a refresh after that keeps the
// older threads; a failed request says so and leaves the list as it was.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (typeof window === "undefined") GlobalRegistrator.register();

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AppRouterContext } = await import(
  "next/dist/shared/lib/app-router-context.shared-runtime"
);
const { RunsList } = await import("./runs-list");
type Run = import("./runs-data").Run;
type AppRouterInstance = import("next/dist/shared/lib/app-router-context.shared-runtime").AppRouterInstance;

const router = {
  push() {},
  replace() {},
  refresh() {},
  back() {},
  forward() {},
  prefetch() {},
} as unknown as AppRouterInstance;

/** Thread `index`, created `index` minutes before the newest one. */
function thread(index: number): Run {
  const at = new Date(Date.UTC(2026, 9, 1) - index * 60_000).toISOString();
  return {
    id: `thread-${index}`,
    prompt: `Thread number ${index}`,
    model: "test-model",
    engine: "codex",
    status: "completed",
    summary: null,
    duration_ms: null,
    project_id: null,
    repo: null,
    repos: [],
    repo_specs: [],
    connector: null,
    created_at: at,
    updated_at: at,
    latest_run_id: `thread-${index}`,
    latest_status: "completed",
    latest_created_at: at,
    latest_updated_at: at,
  };
}

const range = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, offset) => thread(from + offset));

const originalFetch = globalThis.fetch;
const originalEventSource = (globalThis as { EventSource?: unknown }).EventSource;
let requests: string[] = [];
let reply: (url: string) => Response = () => Response.json({ runs: [] });
let changeListeners: Array<(event: Event) => void> = [];
let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  requests = [];
  // happy-dom has no EventSource; the list's org-change subscription opens one,
  // and the test pushes run changes through it.
  changeListeners = [];
  (globalThis as { EventSource?: unknown }).EventSource = class {
    close() {}
    addEventListener(type: string, listener: (event: Event) => void) {
      if (type === "change") changeListeners.push(listener);
    }
    removeEventListener() {}
  };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    return reply(url);
  }) as typeof fetch;
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  globalThis.fetch = originalFetch;
  (globalThis as { EventSource?: unknown }).EventSource = originalEventSource;
});

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount(initialRuns: Run[], initialNextCursor: string | null) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <AppRouterContext.Provider value={router}>
        <RunsList initialRuns={initialRuns} initialNextCursor={initialNextCursor} initialError={false} />
      </AppRouterContext.Provider>,
    );
  });
  // The mount refresh: the first page again.
  await settle();
}

function olderButton(): HTMLButtonElement | null {
  return (Array.from(container?.querySelectorAll("button") ?? []).find((el) =>
    /older threads/.test(el.textContent ?? ""),
  ) ?? null) as HTMLButtonElement | null;
}

async function showOlder() {
  const button = olderButton();
  if (!button) throw new Error("no Show older threads button");
  await click(button);
}

/** A run changed somewhere in the org: the list refreshes its first page. */
async function runChanged() {
  const data = JSON.stringify({ type: "run", action: "created", runId: "thread-new", threadId: "thread-new" });
  await act(async () => {
    for (const listener of changeListeners) listener(new window.MessageEvent("change", { data }));
  });
  await settle();
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await settle();
}

const text = () => container?.textContent ?? "";

test("Show older threads appends the next page and opens the page it starts on", async () => {
  const firstPage = range(0, 10);
  reply = (url) =>
    url.includes("cursor=")
      ? Response.json({ runs: range(10, 22), has_more: false, next_cursor: null })
      : Response.json({ runs: firstPage, has_more: true, next_cursor: "page-2" });
  await mount(firstPage, "page-2");

  expect(text()).toContain("10 of 10 runs");
  expect(container?.querySelector('input[placeholder="Search loaded threads"]')).not.toBeNull();
  expect(olderButton()?.textContent).toBe("Show older threads");

  await showOlder();

  expect(requests).toContain("/api/runs?view=summary&limit=100&cursor=page-2");
  expect(text()).toContain("22 of 22 runs");
  // Page 2 of 3: the first older threads, not the ten already shown.
  expect(text()).toContain("Thread number 10");
  expect(text()).not.toContain("Thread number 9");
  // Every thread is loaded, and search covers all of them again.
  expect(olderButton()).toBeNull();
  expect(container?.querySelector('input[placeholder="Search"]')).not.toBeNull();
});

test("a refresh after loading older threads keeps every loaded thread", async () => {
  let firstPage = range(0, 5);
  reply = (url) =>
    url.includes("cursor=")
      ? Response.json({ runs: range(5, 8), has_more: true, next_cursor: "page-3" })
      : Response.json({ runs: firstPage, has_more: true, next_cursor: "page-2" });
  await mount(firstPage, "page-2");
  await showOlder();
  expect(text()).toContain("8 of 8 runs");

  // A new thread pushes thread 4 out of the refreshed first page; it stays
  // listed, and the next older page still starts after the loaded ones.
  firstPage = [{ ...thread(-1), prompt: "Brand new thread" }, ...range(0, 4)];
  await runChanged();

  expect(requests.at(-1)).toBe("/api/runs?view=summary&limit=100&include_active=1");
  expect(text()).toContain("9 of 9 runs");
  await showOlder();
  expect(requests.at(-1)).toBe("/api/runs?view=summary&limit=100&cursor=page-3");
});

test("a failed older page says so and keeps the threads already shown", async () => {
  const firstPage = range(0, 5);
  reply = (url) =>
    url.includes("cursor=")
      ? new Response("nope", { status: 500 })
      : Response.json({ runs: firstPage, has_more: true, next_cursor: "page-2" });
  await mount(firstPage, "page-2");

  await showOlder();

  expect(container?.querySelector('[role="alert"]')?.textContent).toBe(
    "Couldn't load older threads. Try again.",
  );
  expect(text()).toContain("5 of 5 runs");
  expect(olderButton()?.disabled).toBe(false);
});
