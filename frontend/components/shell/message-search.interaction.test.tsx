// Mounts useMessageSearch in happy-dom over a stubbed fetcher and types into it
// the way the ⌘K input does: a pause before asking, one request for a burst of
// keystrokes, an older answer never shown over a newer query, and a failed
// request reported as failed, never as no matches.
import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (typeof window === "undefined") GlobalRegistrator.register();

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MESSAGE_SEARCH_DEBOUNCE_MS, useMessageSearch } = await import("./message-search");

type Fetcher = (path: string, init?: RequestInit) => Promise<Response>;
type State = ReturnType<typeof useMessageSearch>;

const MATCH_WIRE = {
  thread_id: "thread-1",
  run_id: "run-2",
  thread_prompt: "Fix the flaky checkout test",
  role: "agent",
  snippet: "The checkout test raced the payment webhook.",
  created_at: "2026-11-01T10:00:00.000Z",
};

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLElement | null = null;
let latest: State | null = null;

function Probe({ search, fetcher }: { search: string; fetcher: Fetcher }) {
  latest = useMessageSearch(search, fetcher as never);
  return null;
}

function render(search: string, fetcher: Fetcher) {
  if (!root) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  act(() => root?.render(<Probe search={search} fetcher={fetcher} />));
}

async function settle(ms = MESSAGE_SEARCH_DEBOUNCE_MS + 50) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  latest = null;
});

describe("useMessageSearch", () => {
  test("asks once after the typing pauses, for the last query only", async () => {
    const paths: string[] = [];
    const fetcher: Fetcher = async (path) => {
      paths.push(path);
      return new Response(JSON.stringify({ matches: [MATCH_WIRE] }));
    };
    render("we", fetcher);
    render("webh", fetcher);
    render("webhook", fetcher);
    expect(latest).toEqual({ status: "loading" });
    expect(paths).toEqual([]);

    await settle();
    expect(paths).toEqual(["/api/runs/search?q=webhook"]);
    expect(latest).toEqual({
      status: "ready",
      matches: [
        {
          threadId: "thread-1",
          runId: "run-2",
          threadPrompt: "Fix the flaky checkout test",
          role: "agent",
          snippet: "The checkout test raced the payment webhook.",
          createdAt: "2026-11-01T10:00:00.000Z",
        },
      ],
    });
  });

  test("stays idle and asks nothing for a query under two characters", async () => {
    let calls = 0;
    const fetcher: Fetcher = async () => {
      calls += 1;
      return new Response(JSON.stringify({ matches: [] }));
    };
    render(" w ", fetcher);
    await settle();
    expect(latest).toEqual({ status: "idle" });
    expect(calls).toBe(0);
  });

  test("aborts the request in flight when the query changes, and keeps the newer answer", async () => {
    const signals: AbortSignal[] = [];
    let releaseFirst: (() => void) | null = null;
    const fetcher: Fetcher = (path, init) => {
      if (init?.signal) signals.push(init.signal);
      if (path.endsWith("q=webhook")) {
        return new Promise((resolve) => {
          releaseFirst = () => resolve(new Response(JSON.stringify({ matches: [MATCH_WIRE] })));
        });
      }
      return Promise.resolve(new Response(JSON.stringify({ matches: [] })));
    };
    render("webhook", fetcher);
    await settle();
    expect(latest).toEqual({ status: "loading" });

    render("invoice", fetcher);
    await settle();
    expect(signals[0]?.aborted).toBe(true);
    expect(latest).toEqual({ status: "ready", matches: [] });

    await act(async () => {
      releaseFirst?.();
      await Promise.resolve();
    });
    expect(latest).toEqual({ status: "ready", matches: [] });
  });

  test("a failed request is failed, not an empty list", async () => {
    const fetcher: Fetcher = async () =>
      new Response(JSON.stringify({ error: "Searching messages took too long. Try again." }), {
        status: 503,
      });
    render("webhook", fetcher);
    await settle();
    expect(latest).toEqual({ status: "failed" });
  });

  test("clearing the query goes back to idle", async () => {
    const fetcher: Fetcher = async () => new Response(JSON.stringify({ matches: [MATCH_WIRE] }));
    render("webhook", fetcher);
    await settle();
    expect(latest?.status).toBe("ready");
    render("", fetcher);
    expect(latest).toEqual({ status: "idle" });
  });
});
