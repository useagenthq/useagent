// What a person types reaches the sandbox shell, from a laptop keyboard and from a
// phone's on-screen keyboard (#422). Mounts the real pane with the real ghostty-web
// (only its canvas drawing and the socket are stand-ins) and reads what the pane
// sends on its PTY socket.
//
// A phone keyboard reports every key as keydown 229 "Unidentified" and delivers the
// text, Enter and Backspace as `beforeinput` on the focused hidden textarea. A
// terminal library that only reads keydown drops all of it.
//
// The stand-ins come back out in afterAll: these globals are shared with every test
// file loaded after this one.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (typeof window === "undefined") GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static opened: FakeSocket[] = [];
  readyState = 1;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.opened.push(this);
  }
  send(frame: string) {
    this.sent.push(frame);
  }
  close() {
    this.readyState = FakeSocket.CLOSED;
  }
}

/** A 2D context that accepts every draw call: happy-dom has no canvas, and the
 * renderer only needs text metrics back. */
function inertCanvasContext(): unknown {
  const metrics = {
    width: 8,
    actualBoundingBoxAscent: 10,
    actualBoundingBoxDescent: 3,
    fontBoundingBoxAscent: 11,
    fontBoundingBoxDescent: 3,
  };
  const state: Record<PropertyKey, unknown> = {};
  return new Proxy(state, {
    get: (target, key) => {
      if (key in target) return target[key];
      if (key === "measureText") return () => metrics;
      if (key === "getImageData") return () => ({ data: new Uint8ClampedArray(4) });
      return () => undefined;
    },
    set: (target, key, value) => {
      target[key] = value;
      return true;
    },
  });
}

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { InteractiveTerminal } = await import("./interactive-terminal");

const realWebSocket = globalThis.WebSocket;
const realResizeObserver = globalThis.ResizeObserver;
const realGetContext = HTMLCanvasElement.prototype.getContext;

beforeAll(() => {
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver;
  HTMLCanvasElement.prototype.getContext = (() =>
    inertCanvasContext()) as unknown as typeof realGetContext;
});

afterAll(() => {
  globalThis.WebSocket = realWebSocket;
  globalThis.ResizeObserver = realResizeObserver;
  HTMLCanvasElement.prototype.getContext = realGetContext;
});

afterEach(() => {
  FakeSocket.opened = [];
});

/** Mounts the pane and waits for its boot (WASM, fonts) to open the PTY socket. */
async function mountTerminal() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<InteractiveTerminal runId="run-1" />));
  for (let i = 0; i < 200 && FakeSocket.opened.length === 0; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  const socket = FakeSocket.opened[0];
  const input = host.querySelector("textarea");
  if (!socket || !input) throw new Error("the terminal did not open its socket and input");
  const typed = () =>
    socket.sent
      .map((frame) => JSON.parse(frame) as { type: string; data?: string })
      .filter((frame) => frame.type === "input")
      .map((frame) => frame.data);
  const cleanup = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  return { input, typed, cleanup };
}

/** One key on a phone keyboard: keydown 229, then the edit as `beforeinput`. */
function phoneKey(input: HTMLTextAreaElement, inputType: string, data?: string) {
  input.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Unidentified",
      keyCode: 229,
      bubbles: true,
      cancelable: true,
    }),
  );
  input.dispatchEvent(
    new InputEvent("beforeinput", { inputType, data, bubbles: true, cancelable: true }),
  );
}

/** happy-dom's CompositionEvent drops `data`, so carry it on a plain event. */
function composition(type: string, data: string): Event {
  return Object.assign(new Event(type, { bubbles: true }), { data });
}

test("a phone keyboard's letters, Backspace and Enter reach the shell", async () => {
  const terminal = await mountTerminal();
  phoneKey(terminal.input, "insertText", "l");
  phoneKey(terminal.input, "insertText", "s");
  phoneKey(terminal.input, "deleteContentBackward");
  phoneKey(terminal.input, "insertText", "s");
  phoneKey(terminal.input, "insertText", "👋");
  phoneKey(terminal.input, "insertLineBreak");
  expect(terminal.typed()).toEqual(["l", "s", "\x7f", "s", "👋", "\r"]);
  await terminal.cleanup();
});

test("a word finished by the phone's autocomplete reaches the shell once", async () => {
  const terminal = await mountTerminal();
  terminal.input.dispatchEvent(composition("compositionstart", ""));
  terminal.input.dispatchEvent(composition("compositionupdate", "ec"));
  terminal.input.dispatchEvent(composition("compositionend", "echo"));
  // Some keyboards report the committed word again as text right after.
  phoneKey(terminal.input, "insertText", "echo");
  expect(terminal.typed()).toEqual(["echo"]);
  await terminal.cleanup();
});

test("a laptop key is sent once, from its keydown", async () => {
  const terminal = await mountTerminal();
  terminal.input.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "a",
      code: "KeyA",
      keyCode: 65,
      bubbles: true,
      cancelable: true,
    }),
  );
  terminal.input.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      bubbles: true,
      cancelable: true,
    }),
  );
  expect(terminal.typed()).toEqual(["a", "\r"]);
  await terminal.cleanup();
});

test("the terminal opens with its input focused, and focus on the pane moves there", async () => {
  const terminal = await mountTerminal();
  expect(document.activeElement?.tagName).toBe("TEXTAREA");
  // A tap on the padding around the canvas focuses the pane element itself.
  const pane = terminal.input.parentElement;
  if (!pane) throw new Error("the input has no pane");
  terminal.input.blur();
  pane.focus();
  expect(document.activeElement?.tagName).toBe("TEXTAREA");
  phoneKey(terminal.input, "insertText", "l");
  expect(terminal.typed()).toEqual(["l"]);
  await terminal.cleanup();
});

test("a finished word is cleared from the input, so the keyboard cannot send it again", async () => {
  const terminal = await mountTerminal();
  terminal.input.dispatchEvent(composition("compositionstart", ""));
  // The browser puts the word being composed into the textarea.
  terminal.input.value = "echo";
  terminal.input.dispatchEvent(composition("compositionend", "echo"));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(terminal.input.value).toBe("");
  expect(terminal.typed()).toEqual(["echo"]);
  await terminal.cleanup();
});

test("a word already being typed is not cleared when the previous word ends", async () => {
  const terminal = await mountTerminal();
  terminal.input.dispatchEvent(composition("compositionstart", ""));
  terminal.input.dispatchEvent(composition("compositionend", "echo"));
  // The next word begins before the clear runs.
  terminal.input.dispatchEvent(composition("compositionstart", ""));
  terminal.input.value = "hi";
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(terminal.input.value).toBe("hi");
  await terminal.cleanup();
});
