// Show older pages on the Wiki. WikiIndex and WikiDocRail are mounted under
// happy-dom with a stubbed fetch: past the server-rendered page they read the
// page after the backend's cursor, append it without repeating a document, say
// when a page fails and retry the same cursor, and send one request for a
// double click.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactNode } from "react";

if (typeof window === "undefined") GlobalRegistrator.register();

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { WikiIndex } = await import("./wiki-index");
const { WikiDocRail } = await import("./wiki-doc-rail");

function doc(index: number) {
  return {
    id: `d${index}`,
    title: `Page ${index}`,
    slug: null,
    status: "published",
    excerpt: `About page ${index}.`,
    revisionId: null,
    publishedRevisionId: null,
    updatedAt: "2026-11-01T10:00:00.000Z",
    createdAt: "2026-11-01T10:00:00.000Z",
  };
}

const docs = (...indices: number[]) => indices.map(doc);
const pagePath = (cursor: string) => `/api/knowledge/documents?status=published&cursor=${cursor}`;

const originalFetch = globalThis.fetch;
let requested: string[] = [];
/** Answers by request path; a path missing here answers 503. */
let answers: Record<string, { documents: ReturnType<typeof doc>[]; next_cursor: string | null }> =
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
    return new Response(JSON.stringify({ ...body, has_more: body.next_cursor !== null }));
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

function render(node: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function mountIndex(initialDocs: ReturnType<typeof docs>, initialNextCursor: string | null) {
  render(
    <WikiIndex initialDocs={initialDocs} initialNextCursor={initialNextCursor} failed={false} />,
  );
}

/** The titles of the index cards, in order. */
const cardTitles = () =>
  [...(container?.querySelectorAll("article li") ?? [])]
    .map((row) => /Page \d+/.exec(row.textContent ?? "")?.[0])
    .filter((title): title is string => Boolean(title));

/** The titles in the pages rail, in order. */
const railTitles = () =>
  [...(container?.querySelectorAll('nav[aria-label="Wiki pages"] li') ?? [])].map(
    (row) => row.textContent,
  );

const olderButton = () =>
  [...(container?.querySelectorAll("button") ?? [])].find((button) =>
    /Show older pages|Try again|Loading older pages/.test(button.textContent ?? ""),
  );

const countChip = () => /\d+\+? published/.exec(container?.textContent ?? "")?.[0];

async function click(button: HTMLElement | undefined) {
  expect(button).toBeDefined();
  await act(async () => {
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("Show older pages on the Wiki index", () => {
  test("appends each older page to the cards and the rail without repeats, and goes away at the end", async () => {
    answers[pagePath("c1")] = { documents: docs(2, 3), next_cursor: "c2" };
    answers[pagePath("c2")] = { documents: docs(4), next_cursor: null };
    mountIndex(docs(1, 2), "c1");
    expect(cardTitles()).toEqual(["Page 1", "Page 2"]);
    expect(container?.textContent).toContain("About page 1.");
    expect(countChip()).toBe("2+ published");

    await click(olderButton());
    expect(cardTitles()).toEqual(["Page 1", "Page 2", "Page 3"]);
    await click(olderButton());
    expect(cardTitles()).toEqual(["Page 1", "Page 2", "Page 3", "Page 4"]);
    expect(railTitles()).toEqual(["Page 1", "Page 2", "Page 3", "Page 4"]);
    expect(requested).toEqual([pagePath("c1"), pagePath("c2")]);
    expect(olderButton()).toBeUndefined();
    expect(countChip()).toBe("4 published");
  });

  test("is not offered when the first page held every document", () => {
    mountIndex(docs(1, 2), null);
    expect(olderButton()).toBeUndefined();
    expect(countChip()).toBe("2 published");
  });

  test("a failed page says so, keeps the documents shown, and Try again resends the same cursor", async () => {
    mountIndex(docs(1), "c1");
    await click(olderButton());
    expect(container?.querySelector('[role="alert"]')?.textContent).toBe(
      "Couldn't load older pages.",
    );
    expect(olderButton()?.textContent).toBe("Try again");
    expect(cardTitles()).toEqual(["Page 1"]);

    answers[pagePath("c1")] = { documents: docs(2), next_cursor: null };
    await click(olderButton());
    expect(requested).toEqual([pagePath("c1"), pagePath("c1")]);
    expect(cardTitles()).toEqual(["Page 1", "Page 2"]);
    expect(container?.querySelector('[role="alert"]')).toBeNull();
  });

  test("a double click sends one request", async () => {
    answers[pagePath("c1")] = { documents: docs(2), next_cursor: null };
    let open: () => void = () => {};
    gate = new Promise((resolve) => {
      open = resolve;
    });
    mountIndex(docs(1), "c1");
    const button = olderButton();
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(olderButton()?.textContent).toBe("Loading older pages…");
    await act(async () => {
      open();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(requested).toEqual([pagePath("c1")]);
    expect(cardTitles()).toEqual(["Page 1", "Page 2"]);
  });
});

describe("Show older pages beside one document", () => {
  test("the rail adds older pages and keeps the open document marked", async () => {
    answers[pagePath("c1")] = { documents: docs(3), next_cursor: null };
    render(<WikiDocRail initialDocs={docs(1, 2)} initialNextCursor="c1" activeId="d3" />);
    expect(railTitles()).toEqual(["Page 1", "Page 2"]);

    await click(olderButton());
    expect(railTitles()).toEqual(["Page 1", "Page 2", "Page 3"]);
    expect(olderButton()).toBeUndefined();
    const active = [...(container?.querySelectorAll("nav a") ?? [])].find(
      (link) => link.getAttribute("href") === "/wiki/d3",
    );
    expect(active?.className).toContain("text-text-primary");
    expect(active?.className).not.toContain("text-text-secondary");
  });
});
