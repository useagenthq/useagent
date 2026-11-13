// Show older knowledge on the Knowledge page. KnowledgeGallery is mounted
// under happy-dom with a stubbed fetch: past the server-rendered page it reads
// the page after the backend's cursor, appends it without repeating a record,
// says when a page fails and retries the same cursor, and sends one request
// for a double click.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (typeof window === "undefined") GlobalRegistrator.register();

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { KnowledgeGallery } = await import("./knowledge-gallery");
const { recordToItem } = await import("./knowledge-data");

function record(index: number) {
  return {
    id: `r${index}`,
    kind: "reference" as const,
    title: `Record ${index}`,
    body: `Body ${index}`,
    refs: [],
    domain: "Global",
    connector_instance_id: "manual:web",
    pinned: false,
    created_at: "2026-11-01T10:00:00.000Z",
  };
}

const items = (...indices: number[]) => indices.map((index) => recordToItem(record(index)));

const originalFetch = globalThis.fetch;
let requested: string[] = [];
/** Answers by request path; a path missing here answers 503. */
let answers: Record<string, { records: ReturnType<typeof record>[]; next_cursor: string | null }> =
  {};
/** When set, answers wait for it. */
let gate: Promise<void> | null = null;

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLElement | null = null;

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
    return new Response(
      JSON.stringify({ ...body, has_more: body.next_cursor !== null, search_note: null }),
    );
  }) as typeof fetch;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

function mount(props: {
  initialItems: ReturnType<typeof items>;
  initialNextCursor: string | null;
  initialLive?: boolean;
}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      <KnowledgeGallery
        initialItems={props.initialItems}
        initialNextCursor={props.initialNextCursor}
        initialLive={props.initialLive ?? true}
        initialError={false}
      />,
    ),
  );
}

const titles = () =>
  [...(container?.querySelectorAll("li") ?? [])]
    .map((row) => row.textContent ?? "")
    .map((text) => /Record \d+/.exec(text)?.[0])
    .filter((title): title is string => Boolean(title));

const olderButton = () =>
  [...(container?.querySelectorAll("button") ?? [])].find((button) =>
    /Show older knowledge|Try again|Loading older knowledge/.test(button.textContent ?? ""),
  );

async function click(button: HTMLElement | undefined) {
  expect(button).toBeDefined();
  await act(async () => {
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("Show older knowledge", () => {
  test("appends each older page without repeats, and goes away at the end", async () => {
    answers["/api/knowledge?cursor=c1"] = { records: [record(2), record(3)], next_cursor: "c2" };
    answers["/api/knowledge?cursor=c2"] = { records: [record(4)], next_cursor: null };
    mount({ initialItems: items(1, 2), initialNextCursor: "c1" });
    expect(titles()).toEqual(["Record 1", "Record 2"]);

    await click(olderButton());
    expect(titles()).toEqual(["Record 1", "Record 2", "Record 3"]);
    await click(olderButton());
    expect(titles()).toEqual(["Record 1", "Record 2", "Record 3", "Record 4"]);
    expect(requested).toEqual(["/api/knowledge?cursor=c1", "/api/knowledge?cursor=c2"]);
    expect(olderButton()).toBeUndefined();
  });

  test("is not offered when the first page held every record", () => {
    mount({ initialItems: items(1, 2), initialNextCursor: null });
    expect(olderButton()).toBeUndefined();
  });

  test("waits until the loaded rows behind Show more are shown", async () => {
    const many = Array.from({ length: 35 }, (_, index) => index + 1);
    mount({ initialItems: items(...many), initialNextCursor: "c1" });
    expect(olderButton()).toBeUndefined();
    const showMore = [...(container?.querySelectorAll("button") ?? [])].find((button) =>
      /Show 5 more/.test(button.textContent ?? ""),
    );
    await click(showMore);
    expect(olderButton()?.textContent).toBe("Show older knowledge");
  });

  test("a failed page says so, keeps the records shown, and Try again resends the same cursor", async () => {
    mount({ initialItems: items(1), initialNextCursor: "c1" });
    await click(olderButton());
    expect(container?.querySelector('[role="alert"]')?.textContent).toBe(
      "Couldn't load older knowledge.",
    );
    expect(olderButton()?.textContent).toBe("Try again");
    expect(titles()).toEqual(["Record 1"]);

    answers["/api/knowledge?cursor=c1"] = { records: [record(2)], next_cursor: null };
    await click(olderButton());
    expect(requested).toEqual(["/api/knowledge?cursor=c1", "/api/knowledge?cursor=c1"]);
    expect(titles()).toEqual(["Record 1", "Record 2"]);
    expect(container?.querySelector('[role="alert"]')).toBeNull();
  });

  test("a refresh before any older page replaces the list and takes the newest page's cursor", async () => {
    answers["/api/knowledge"] = { records: [record(7), record(8)], next_cursor: "c9" };
    answers["/api/knowledge?cursor=c9"] = { records: [record(9)], next_cursor: null };
    // Server-rendered from the fallback sample: the page refreshes once on mount.
    await act(async () => {
      mount({ initialItems: items(1), initialNextCursor: null, initialLive: false });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(titles()).toEqual(["Record 7", "Record 8"]);
    await click(olderButton());
    expect(requested).toEqual(["/api/knowledge", "/api/knowledge?cursor=c9"]);
    expect(titles()).toEqual(["Record 7", "Record 8", "Record 9"]);
  });

  test("a double click sends one request", async () => {
    answers["/api/knowledge?cursor=c1"] = { records: [record(2)], next_cursor: null };
    let open: () => void = () => {};
    gate = new Promise((resolve) => {
      open = resolve;
    });
    mount({ initialItems: items(1), initialNextCursor: "c1" });
    const button = olderButton();
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(olderButton()?.textContent).toBe("Loading older knowledge…");
    await act(async () => {
      open();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(requested).toEqual(["/api/knowledge?cursor=c1"]);
    expect(titles()).toEqual(["Record 1", "Record 2"]);
  });
});
