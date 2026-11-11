// All threads past the newest page. RunsList is mounted under happy-dom with
// the real runs-data helpers over a stubbed fetch: Show older threads asks for
// the page after the cursor the backend sent, appends it without repeating a
// thread the live newest page already has, goes away on the last page, and a
// failed page says so and offers Try again.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (typeof window === "undefined") GlobalRegistrator.register();

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// A stand-in for the org change stream, so a test can announce a run change
// the way the backend does and make the list re-read its newest page.
let changeListeners: Array<(event: MessageEvent) => void> = [];
class FakeEventSource {
  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    if (type === "change") changeListeners.push(listener);
  }
  removeEventListener() {}
  close() {
    changeListeners = [];
  }
}
const originalEventSource = (globalThis as { EventSource?: unknown }).EventSource;
(globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;

function announceRunChange() {
  const data = JSON.stringify({ type: "run", action: "created", runId: "c-2", threadId: "c" });
  for (const listener of changeListeners) listener(new MessageEvent("change", { data }));
}

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AppRouterContext } = await import(
  "next/dist/shared/lib/app-router-context.shared-runtime"
);
const { RunsList } = await import("./runs-list");
type Run = import("./runs-data").Run;

const router = {
  push() {},
  replace() {},
  refresh() {},
  back() {},
  forward() {},
  prefetch() {},
};

function thread(id: string): Run {
  return {
    id,
    prompt: `Thread ${id}`,
    model: "gpt-5.6-sol",
    engine: "codex",
    status: "completed",
    summary: null,
    duration_ms: null,
    project_id: null,
    repo: null,
    repos: [],
    repo_specs: [],
    connector: null,
    created_at: "2026-09-14T00:00:00.000Z",
    updated_at: "2026-09-14T00:01:00.000Z",
    latest_run_id: id,
    latest_status: "completed",
    latest_created_at: "2026-09-14T00:00:00.000Z",
    latest_updated_at: "2026-09-14T00:01:00.000Z",
  };
}

const NEWEST = "/api/runs?view=summary&limit=100&include_active=1";
const originalFetch = globalThis.fetch;
let requested: string[] = [];
let pages: Record<string, () => Response> = {};
let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  requested = [];
  pages = {
    [NEWEST]: () => Response.json({ runs: [thread("a"), thread("b")], has_more: true, next_cursor: "c1" }),
  };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requested.push(url);
    const page = pages[url];
    return page ? page() : new Response("{}", { status: 404 });
  }) as typeof fetch;
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  (globalThis as { EventSource?: unknown }).EventSource = originalEventSource;
});

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <AppRouterContext.Provider value={router as never}>
        <RunsList
          initialRuns={[thread("a"), thread("b")]}
          initialNextCursor="c1"
          initialError={false}
        />
      </AppRouterContext.Provider>,
    );
  });
  await flush();
}

function button(label: string): HTMLButtonElement | null {
  return (Array.from(container?.querySelectorAll("button") ?? []).find((el) =>
    (el.textContent ?? "").includes(label),
  ) as HTMLButtonElement | undefined) ?? null;
}

async function click(label: string) {
  const target = button(label);
  if (!target) throw new Error(`no button labelled ${label}`);
  await act(async () => {
    target.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await flush();
}

function loaded(): string | null {
  return container?.textContent?.match(/(\d+) of (\d+) runs/)?.[0] ?? null;
}

describe("Show older threads", () => {
  test("appends the next pages until the backend says there are no more", async () => {
    pages[`${NEWEST}&cursor=c1`] = () =>
      Response.json({ runs: [thread("b"), thread("c")], has_more: true, next_cursor: "c2" });
    pages[`${NEWEST}&cursor=c2`] = () =>
      Response.json({ runs: [thread("d")], has_more: false, next_cursor: null });
    await mount();
    expect(loaded()).toBe("2 of 2 runs");

    await click("Show older threads");
    expect(requested).toContain(`${NEWEST}&cursor=c1`);
    expect(loaded()).toBe("3 of 3 runs");
    expect(container?.textContent).toContain("Thread c");

    await click("Show older threads");
    expect(requested).toContain(`${NEWEST}&cursor=c2`);
    expect(loaded()).toBe("4 of 4 runs");
    expect(button("Show older threads")).toBeNull();
  });

  test("keeps older threads when the newest page refreshes", async () => {
    pages[`${NEWEST}&cursor=c1`] = () =>
      Response.json({ runs: [thread("c")], has_more: false, next_cursor: null });
    await mount();
    await click("Show older threads");
    expect(loaded()).toBe("3 of 3 runs");

    // Thread c got a new turn, so the newest page now leads with it.
    pages[NEWEST] = () =>
      Response.json({ runs: [thread("c"), thread("a"), thread("b")], has_more: true, next_cursor: "c9" });
    const before = requested.length;
    await act(async () => announceRunChange());
    await flush();

    expect(requested.slice(before)).toEqual([NEWEST]);
    expect(loaded()).toBe("3 of 3 runs");
    // The older pages already reached the end, so the fresh newest-page cursor
    // does not bring the button back.
    expect(button("Show older threads")).toBeNull();
  });

  test("says a page failed and tries the same cursor again", async () => {
    let fail = true;
    pages[`${NEWEST}&cursor=c1`] = () =>
      fail
        ? new Response("{}", { status: 503 })
        : Response.json({ runs: [thread("c")], has_more: false, next_cursor: null });
    await mount();

    await click("Show older threads");
    expect(container?.querySelector('[role="alert"]')?.textContent).toBe(
      "Couldn't load older threads.",
    );
    expect(loaded()).toBe("2 of 2 runs");

    fail = false;
    await click("Try again");
    expect(requested.filter((url) => url === `${NEWEST}&cursor=c1`)).toHaveLength(2);
    expect(container?.querySelector('[role="alert"]')).toBeNull();
    expect(loaded()).toBe("3 of 3 runs");
    expect(button("Show older threads")).toBeNull();
  });
});
