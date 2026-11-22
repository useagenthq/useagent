// Show older runs in a firing history. The hook is mounted under happy-dom with
// the real routine history client over a stubbed fetch, and the list and the
// control the drawers render: it reads the page after the backend's cursor,
// appends it without repeating a run, says when a page fails and retries the
// same cursor, sends one request for a double click, keeps the older runs when
// the newest page is read again, and drops a late answer after a reset.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (typeof window === "undefined") GlobalRegistrator.register();

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act, useCallback } = await import("react");
const { createRoot } = await import("react-dom/client");
const { fetchRoutineHistory } = await import("@/components/bots/routines-api");
const { RoutineHistoryList } = await import("@/components/bots/routine-history");
const { firingCountLabel, OlderFirings } = await import("./older-firings");
const { useFiringHistory } = await import("./use-firing-history");

const PATH = "/api/bots/b1/routines/r1/history";

function firing(index: number) {
  return {
    id: `f${index}`,
    run_id: `run-${index}`,
    fired_at: `2026-03-01T12:${String(60 - index).padStart(2, "0")}:00.000Z`,
    trigger: "cron",
    status: "completed",
    run_status: "completed",
    run_summary: `Run ${index}`,
  };
}

const originalFetch = globalThis.fetch;
let requested: string[] = [];
/** Answers by request path; a path missing here answers 503. */
let answers: Record<string, { firings: ReturnType<typeof firing>[]; next_cursor: string | null }> = {};
/** When set, answers wait for it. */
let gate: Promise<void> | null = null;

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLElement | null = null;
let controls: ReturnType<typeof useFiringHistory> | null = null;

beforeEach(() => {
  requested = [];
  answers = {};
  gate = null;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    requested.push(path);
    if (gate) await gate;
    const body = answers[path];
    if (!body) return new Response(JSON.stringify({ error: "unavailable" }), { status: 503 });
    return new Response(JSON.stringify({ ...body, has_more: body.next_cursor !== null }));
  }) as typeof fetch;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  controls = null;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

function History() {
  const fetchPage = useCallback((cursor: string | null) => fetchRoutineHistory("b1", "r1", cursor), []);
  const history = useFiringHistory(fetchPage);
  controls = history;
  const firings = history.history?.firings ?? null;
  const hasMore = Boolean(history.history?.nextCursor);
  if (!firings) return <p>{history.error ?? "loading"}</p>;
  return (
    <div>
      <span data-count>{firingCountLabel(firings.length, hasMore)}</span>
      <RoutineHistoryList firings={firings} now={null} />
      <OlderFirings hasMore={hasMore} state={history.older} onLoad={() => void history.loadOlder()} />
    </div>
  );
}

async function settle(work: () => Promise<unknown> | unknown = () => undefined) {
  await act(async () => {
    await work();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<History />));
  await settle(() => controls?.refresh());
}

const runs = () =>
  [...(container?.querySelectorAll("li") ?? [])]
    .map((row) => /Run \d+/.exec(row.textContent ?? "")?.[0])
    .filter((label): label is string => Boolean(label));

const count = () => container?.querySelector("[data-count]")?.textContent;

const olderButton = () =>
  [...(container?.querySelectorAll("button") ?? [])].find((button) =>
    /Show older runs|Try again|Loading older runs/.test(button.textContent ?? ""),
  );

async function click(button: HTMLElement | undefined) {
  expect(button).toBeDefined();
  await settle(() => button?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

describe("Show older runs", () => {
  test("appends each older page without repeats, and goes away at the end", async () => {
    answers[PATH] = { firings: [firing(1), firing(2)], next_cursor: "c1" };
    answers[`${PATH}?cursor=c1`] = { firings: [firing(2), firing(3)], next_cursor: "c2" };
    answers[`${PATH}?cursor=c2`] = { firings: [firing(4)], next_cursor: null };
    await mount();
    expect(runs()).toEqual(["Run 1", "Run 2"]);
    expect(count()).toBe("Newest 2");
    expect(olderButton()?.textContent).toBe("Show older runs");

    await click(olderButton());
    expect(runs()).toEqual(["Run 1", "Run 2", "Run 3"]);
    await click(olderButton());
    expect(runs()).toEqual(["Run 1", "Run 2", "Run 3", "Run 4"]);
    expect(requested).toEqual([PATH, `${PATH}?cursor=c1`, `${PATH}?cursor=c2`]);
    expect(olderButton()).toBeUndefined();
    expect(count()).toBe("4 recorded");
  });

  test("is not offered when the first page held every run", async () => {
    answers[PATH] = { firings: [firing(1)], next_cursor: null };
    await mount();
    expect(olderButton()).toBeUndefined();
    expect(count()).toBe("1 recorded");
  });

  test("says when an older page fails, and Try again resends the same cursor", async () => {
    answers[PATH] = { firings: [firing(1)], next_cursor: "c1" };
    await mount();
    await click(olderButton());
    expect(container?.textContent).toContain("Couldn't load older runs.");
    expect(olderButton()?.textContent).toBe("Try again");
    expect(runs()).toEqual(["Run 1"]);

    answers[`${PATH}?cursor=c1`] = { firings: [firing(2)], next_cursor: null };
    await click(olderButton());
    expect(requested).toEqual([PATH, `${PATH}?cursor=c1`, `${PATH}?cursor=c1`]);
    expect(runs()).toEqual(["Run 1", "Run 2"]);
    expect(container?.textContent).not.toContain("Couldn't load older runs.");
  });

  test("a second click while a page loads sends nothing", async () => {
    answers[PATH] = { firings: [firing(1)], next_cursor: "c1" };
    answers[`${PATH}?cursor=c1`] = { firings: [firing(2)], next_cursor: null };
    await mount();
    let open: () => void = () => undefined;
    gate = new Promise((resolve) => {
      open = resolve;
    });
    await click(olderButton());
    expect(olderButton()?.textContent).toBe("Loading older runs");
    await settle(() => controls?.loadOlder());
    open();
    await settle();
    expect(requested.filter((path) => path.includes("cursor"))).toEqual([`${PATH}?cursor=c1`]);
    expect(runs()).toEqual(["Run 1", "Run 2"]);
  });

  test("a refresh after older runs are loaded puts the newest page in front and keeps the rest", async () => {
    answers[PATH] = { firings: [firing(2), firing(3)], next_cursor: "c1" };
    answers[`${PATH}?cursor=c1`] = { firings: [firing(4)], next_cursor: "c2" };
    await mount();
    await click(olderButton());
    expect(runs()).toEqual(["Run 2", "Run 3", "Run 4"]);

    answers[PATH] = { firings: [firing(1), firing(2)], next_cursor: "c-new" };
    await settle(() => controls?.refresh());
    expect(runs()).toEqual(["Run 1", "Run 2", "Run 3", "Run 4"]);
    // Still asks for what follows the oldest loaded run.
    answers[`${PATH}?cursor=c2`] = { firings: [firing(5)], next_cursor: null };
    await click(olderButton());
    expect(requested.at(-1)).toBe(`${PATH}?cursor=c2`);
    expect(runs()).toEqual(["Run 1", "Run 2", "Run 3", "Run 4", "Run 5"]);
  });

  test("a reset drops an answer that arrives after it", async () => {
    answers[PATH] = { firings: [firing(1)], next_cursor: null };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(<History />));
    let open: () => void = () => undefined;
    gate = new Promise((resolve) => {
      open = resolve;
    });
    let pending: Promise<void> | undefined;
    await settle(() => {
      pending = controls?.refresh();
    });
    await settle(() => controls?.reset());
    open();
    await settle(() => pending);
    expect(runs()).toEqual([]);
    expect(container.textContent).toBe("loading");
  });
});
