// When the Artifacts page reads GET /api/artifacts. LiveArtifacts is mounted
// under happy-dom with a held fetch and a stand-in org change stream: it sets
// no timer, reads once each time the stream opens, on an artifact change and
// when the tab comes back, folds a burst of changes into one follow-up read,
// and spins the refresh icon only for a click. Past the newest page, Show
// older files reads the page after the backend's cursor and keeps it loaded
// while the newest page refreshes.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ArtifactDescriptor } from "@/components/artifacts/model";

if (typeof window === "undefined") GlobalRegistrator.register();

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// happy-dom has no EventSource. This one lets a test open the stream and send
// change events the way the backend does.
type StreamListener = (event: Event) => void;
let streamListeners: Array<{ type: string; listener: StreamListener }> = [];
class FakeEventSource {
  addEventListener(type: string, listener: StreamListener) {
    streamListeners.push({ type, listener });
  }
  removeEventListener() {}
  close() {
    streamListeners = [];
  }
}
const originalEventSource = (globalThis as { EventSource?: unknown }).EventSource;
(globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { LiveArtifacts } = await import("./live-artifacts");

function artifact(id: string, name: string): ArtifactDescriptor {
  return {
    id,
    run_id: "r1",
    thread_id: "t1",
    name,
    source_path: `/root/work/${name}`,
    content_type: "text/plain",
    size_bytes: 12,
    sha256: "abc123",
    created_at: "2026-01-01T00:00:00Z",
    preview_url: `/api/artifacts/${id}/content`,
    download_url: `/api/artifacts/${id}/content?download=1`,
    preview_pdf_url: null,
    workpiece: null,
  };
}

const originalFetch = globalThis.fetch;
const originalSetInterval = globalThis.setInterval;
let reads: Array<(artifacts: ArtifactDescriptor[], nextCursor?: string | null) => void> = [];
/** Older pages by cursor; a missing cursor answers 503. */
let olderPages: Record<string, { artifacts: ArtifactDescriptor[]; next_cursor: string | null }> = {};
let requested: string[] = [];
let intervals: number[] = [];
let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  reads = [];
  intervals = [];
  olderPages = {};
  requested = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const path = String(input);
    requested.push(path);
    if (path.startsWith("/api/artifacts?cursor=")) {
      const page = olderPages[decodeURIComponent(path.slice("/api/artifacts?cursor=".length))];
      return Promise.resolve(page ? Response.json(page) : Response.json({ error: "unavailable" }, { status: 503 }));
    }
    if (path !== "/api/artifacts") {
      return Promise.resolve(new Response("{}", { status: 404 }));
    }
    return new Promise<Response>((resolve) => {
      reads.push((artifacts, nextCursor = null) =>
        resolve(Response.json({ artifacts, has_more: nextCursor !== null, next_cursor: nextCursor })),
      );
    });
  }) as typeof fetch;
  globalThis.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    intervals.push(timeout ?? 0);
    return originalSetInterval(handler, timeout, ...args);
  }) as typeof setInterval;
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  globalThis.fetch = originalFetch;
  globalThis.setInterval = originalSetInterval;
});

afterAll(() => {
  (globalThis as { EventSource?: unknown }).EventSource = originalEventSource;
});

async function mount(
  initialArtifacts = [artifact("a1", "first.txt")],
  initialNextCursor: string | null = null,
) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <LiveArtifacts
        initialArtifacts={initialArtifacts}
        initialNextCursor={initialNextCursor}
        initialAvailable
      />,
    );
  });
}

async function emit(type: string, data?: unknown) {
  await act(async () => {
    const event =
      data === undefined
        ? new Event(type)
        : new MessageEvent(type, { data: JSON.stringify(data) });
    for (const entry of streamListeners) {
      if (entry.type === type) entry.listener(event);
    }
    await Promise.resolve();
  });
}

function artifactChange(artifactId: string) {
  return emit("change", { type: "artifact", action: "created", artifactId, runId: "r1", threadId: "t1" });
}

async function answer(artifacts: ArtifactDescriptor[], nextCursor: string | null = null) {
  await act(async () => {
    reads.shift()?.(artifacts, nextCursor);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function refreshIcon(): Element | null {
  return container?.querySelector('button[aria-label="Refresh artifacts"] svg') ?? null;
}

describe("LiveArtifacts reads", () => {
  test("sets no timer and reads nothing until the stream opens", async () => {
    await mount();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(intervals).toEqual([]);
    expect(reads).toHaveLength(0);
    expect(container?.textContent).toContain("first.txt");
  });

  test("reads once when the stream opens and again when it reopens", async () => {
    await mount();

    await emit("open");
    expect(reads).toHaveLength(1);
    expect(refreshIcon()?.getAttribute("class")).not.toContain("animate-spin");
    await answer([artifact("a2", "second.txt"), artifact("a1", "first.txt")]);
    expect(container?.textContent).toContain("second.txt");

    await emit("error");
    await emit("open");
    expect(reads).toHaveLength(1);
    await answer([artifact("a1", "first.txt")]);
    expect(reads).toHaveLength(0);
  });

  test("shows a new file from a change event and folds a burst into one follow-up read", async () => {
    await mount();

    await artifactChange("a2");
    expect(reads).toHaveLength(1);
    await artifactChange("a3");
    await artifactChange("a4");
    await artifactChange("a5");
    expect(reads).toHaveLength(1);

    await answer([artifact("a2", "second.txt"), artifact("a1", "first.txt")]);
    expect(reads).toHaveLength(1);
    await answer([
      artifact("a5", "fifth.txt"),
      artifact("a2", "second.txt"),
      artifact("a1", "first.txt"),
    ]);
    expect(reads).toHaveLength(0);
    expect(container?.textContent).toContain("fifth.txt");
  });

  test("reads when the tab gets focus or becomes visible again", async () => {
    await mount();

    await act(async () => {
      window.dispatchEvent(new window.Event("focus"));
    });
    expect(reads).toHaveLength(1);
    await answer([artifact("a1", "first.txt")]);

    await act(async () => {
      document.dispatchEvent(new window.Event("visibilitychange"));
    });
    expect(reads).toHaveLength(1);
    await answer([artifact("a1", "first.txt")]);
  });

  test("spins the refresh icon for a click, not for a read the page started", async () => {
    await mount();
    await artifactChange("a2");
    expect(refreshIcon()?.getAttribute("class")).not.toContain("animate-spin");

    const button = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="Refresh artifacts"]',
    );
    if (!button) throw new Error("refresh button not found");
    await act(async () => {
      button.click();
    });
    expect(refreshIcon()?.getAttribute("class")).toContain("animate-spin");
    expect(button.disabled).toBe(true);

    // The click came while a read was in flight, so a fresh read follows it
    // and the icon stops only once that one is answered.
    await answer([artifact("a1", "first.txt")]);
    expect(reads).toHaveLength(1);
    expect(refreshIcon()?.getAttribute("class")).toContain("animate-spin");
    await answer([artifact("a1", "first.txt")]);
    expect(refreshIcon()?.getAttribute("class")).not.toContain("animate-spin");
    expect(button.disabled).toBe(false);
  });
});

function button(label: string): HTMLButtonElement | null {
  return (
    [...(container?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
      (candidate) => candidate.textContent?.trim() === label,
    ) ?? null
  );
}

async function click(label: string) {
  const target = button(label);
  if (!target) throw new Error(`no ${label} button`);
  await act(async () => {
    target.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function names(): string[] {
  return [...(container?.querySelectorAll("li") ?? [])].map(
    (row) => row.textContent?.match(/[a-z-]+\.txt/)?.[0] ?? "",
  );
}

describe("LiveArtifacts older pages", () => {
  test("Show older files appends the next pages until the backend has no more", async () => {
    olderPages.c1 = { artifacts: [artifact("a2", "second.txt"), artifact("a3", "third.txt")], next_cursor: "c2" };
    olderPages.c2 = { artifacts: [artifact("a3", "third.txt"), artifact("a4", "fourth.txt")], next_cursor: null };
    await mount([artifact("a1", "first.txt")], "c1");
    expect(names()).toEqual(["first.txt"]);

    await click("Show older files");
    expect(requested).toEqual(["/api/artifacts?cursor=c1"]);
    expect(names()).toEqual(["first.txt", "second.txt", "third.txt"]);

    await click("Show older files");
    expect(requested).toEqual(["/api/artifacts?cursor=c1", "/api/artifacts?cursor=c2"]);
    // third.txt came on both pages and is listed once.
    expect(names()).toEqual(["first.txt", "second.txt", "third.txt", "fourth.txt"]);
    expect(button("Show older files")).toBeNull();
  });

  test("a second click while a page loads sends no second request", async () => {
    olderPages.c1 = { artifacts: [artifact("a2", "second.txt")], next_cursor: "c2" };
    await mount([artifact("a1", "first.txt")], "c1");
    const target = button("Show older files");
    await act(async () => {
      target?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      target?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(requested).toEqual(["/api/artifacts?cursor=c1"]);
    expect(names()).toEqual(["first.txt", "second.txt"]);
  });

  test("no button when the newest page is the only one", async () => {
    await mount([artifact("a1", "first.txt")], null);
    expect(button("Show older files")).toBeNull();
  });

  test("a refresh of the newest page keeps the older pages and their cursor", async () => {
    olderPages.c1 = { artifacts: [artifact("a2", "second.txt")], next_cursor: "c2" };
    olderPages.c2 = { artifacts: [artifact("a3", "third.txt")], next_cursor: null };
    await mount([artifact("a1", "first.txt")], "c1");
    await click("Show older files");

    // A new file arrives; the newest page now leads with it and still holds first.txt.
    await artifactChange("a0");
    await answer([artifact("a0", "zero.txt"), artifact("a1", "first.txt")], "fresh-cursor");
    expect(names()).toEqual(["zero.txt", "first.txt", "second.txt"]);

    // The next older page is still the one after second.txt, not the newest page's cursor.
    await click("Show older files");
    expect(requested.at(-1)).toBe("/api/artifacts?cursor=c2");
    expect(names()).toEqual(["zero.txt", "first.txt", "second.txt", "third.txt"]);
  });

  test("a refresh before any older page is loaded takes the newest page's cursor", async () => {
    olderPages.c9 = { artifacts: [artifact("a2", "second.txt")], next_cursor: null };
    await mount([artifact("a1", "first.txt")], "c1");
    await artifactChange("a0");
    await answer([artifact("a0", "zero.txt")], "c9");
    expect(names()).toEqual(["zero.txt"]);

    await click("Show older files");
    expect(requested.at(-1)).toBe("/api/artifacts?cursor=c9");
    expect(names()).toEqual(["zero.txt", "second.txt"]);
  });

  test("a failed page says so and Try again sends the same cursor", async () => {
    await mount([artifact("a1", "first.txt")], "c1");
    await click("Show older files");
    expect(container?.querySelector('[role="alert"]')?.textContent).toBe("Couldn't load older files.");
    expect(names()).toEqual(["first.txt"]);

    olderPages.c1 = { artifacts: [artifact("a2", "second.txt")], next_cursor: null };
    await click("Try again");
    expect(requested).toEqual(["/api/artifacts?cursor=c1", "/api/artifacts?cursor=c1"]);
    expect(container?.querySelector('[role="alert"]')).toBeNull();
    expect(names()).toEqual(["first.txt", "second.txt"]);
  });
});
