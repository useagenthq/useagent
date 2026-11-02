// The Shell tab keeps its shell across turns: mount the real TerminalPane with
// a stand-in ghostty terminal and WebSocket, then move the thread through a new
// turn, a dropped connection and a switch to another thread. The backend gives
// each socket its own PTY and kills it on close, so a closed socket is a lost
// shell (its directory, scrollback and running command).
import { afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (typeof window === "undefined") GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeTerminal {
  cols = 100;
  rows = 30;
  renderer = undefined;
  loadAddon() {}
  open() {}
  clear() {}
  focus() {}
  write() {}
  dispose() {}
  onData() {}
  onResize() {}
}

mock.module("ghostty-web", () => ({
  Ghostty: { load: async () => ({}) },
  Terminal: FakeTerminal,
  FitAddon: class {
    fit() {}
  },
}));

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static opened: FakeSocket[] = [];
  readyState = 1;
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.opened.push(this);
  }
  send() {}
  close() {
    this.closed = true;
    this.readyState = FakeSocket.CLOSED;
  }
  /** The server ends the connection, as the backend does when it has no shell to give. */
  drop(notice?: string) {
    if (notice) this.onmessage?.({ data: notice });
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }
}

const realWebSocket = globalThis.WebSocket;
globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
globalThis.ResizeObserver ??= class {
  observe() {}
  disconnect() {}
  unobserve() {}
} as unknown as typeof ResizeObserver;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { TerminalPane } = await import("./terminal-pane");

/** Lets the terminal's async boot (dynamic import, fonts) reach `connect()`. */
async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function mountPane() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const render = (threadId: string, runId: string) =>
    act(async () => {
      root.render(
        <TerminalPane steps={[]} live engine="codex" runId={runId} threadId={threadId} />,
      );
    });
  const cleanup = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  return { render, cleanup };
}

/** Runs `fn` with the reconnect back-off timer held, so a test fires it instead of waiting. */
async function holdingBackoff(fn: () => void): Promise<(() => void)[]> {
  const realSetTimeout = globalThis.setTimeout;
  const queued: (() => void)[] = [];
  globalThis.setTimeout = ((handler: () => void, ms?: number) => {
    if (ms === undefined || ms < 3000) return realSetTimeout(handler, ms);
    queued.push(handler);
    return 0;
  }) as typeof setTimeout;
  try {
    await act(async () => fn());
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  return queued;
}

const runOf = (socket: FakeSocket | undefined) =>
  socket?.url.match(/\/api\/runs\/([^/]+)\/terminal/)?.[1];

afterEach(() => {
  FakeSocket.opened = [];
});

test("a new turn in the same thread keeps the open shell", async () => {
  const pane = mountPane();
  await pane.render("thread-a", "run-1");
  await settle();
  expect(FakeSocket.opened.map(runOf)).toEqual(["run-1"]);

  // The reply's run gets its engine session and becomes the newest run.
  await pane.render("thread-a", "run-2");
  await settle();
  expect(FakeSocket.opened).toHaveLength(1);
  expect(FakeSocket.opened[0]?.closed).toBe(false);
  await pane.cleanup();
});

test("a dropped connection reconnects through the thread's newest run", async () => {
  const pane = mountPane();
  await pane.render("thread-a", "run-1");
  await settle();
  await pane.render("thread-a", "run-2");

  const queued = await holdingBackoff(() => FakeSocket.opened[0]?.drop());
  expect(queued).toHaveLength(1);
  await act(async () => queued[0]?.());

  expect(FakeSocket.opened.map(runOf)).toEqual(["run-1", "run-2"]);
  await pane.cleanup();
});

test("with no sandbox yet, the new turn's run connects at once, not after the back-off", async () => {
  const pane = mountPane();
  await pane.render("thread-a", "run-1");
  await settle();
  const queued = await holdingBackoff(() =>
    FakeSocket.opened[0]?.drop("\r\n[UseAgent] no live sandbox yet\r\n"),
  );
  expect(queued).toHaveLength(1);

  await pane.render("thread-a", "run-2");
  expect(FakeSocket.opened.map(runOf)).toEqual(["run-1", "run-2"]);
  // The held back-off finds a connection already open and adds none.
  await act(async () => queued[0]?.());
  expect(FakeSocket.opened).toHaveLength(2);
  await pane.cleanup();
});

test("a terminal that was unavailable tries again when a new turn starts", async () => {
  const pane = mountPane();
  await pane.render("thread-a", "run-1");
  await settle();
  const queued = await holdingBackoff(() =>
    FakeSocket.opened[0]?.drop("\r\n[UseAgent] terminal unavailable: this computer is offline\r\n"),
  );
  // Unavailable ends the retry loop until something changes.
  expect(queued).toHaveLength(0);

  await pane.render("thread-a", "run-2");
  expect(FakeSocket.opened.map(runOf)).toEqual(["run-1", "run-2"]);
  await pane.cleanup();
});

test("opening another thread closes the old shell and starts that thread's own", async () => {
  const pane = mountPane();
  await pane.render("thread-a", "run-1");
  await settle();

  await pane.render("thread-b", "run-9");
  await settle();
  expect(FakeSocket.opened.map(runOf)).toEqual(["run-1", "run-9"]);
  expect(FakeSocket.opened[0]?.closed).toBe(true);
  expect(FakeSocket.opened[1]?.closed).toBe(false);
  await pane.cleanup();
});

test("leaving the pane closes its shell", async () => {
  const pane = mountPane();
  await pane.render("thread-a", "run-1");
  await settle();
  await pane.cleanup();
  expect(FakeSocket.opened[0]?.closed).toBe(true);
  globalThis.WebSocket = realWebSocket;
});
