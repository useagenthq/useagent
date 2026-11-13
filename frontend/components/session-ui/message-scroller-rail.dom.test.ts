// jumpToRunTurn and holdRunTurn on real DOM nodes in happy-dom: a turn found
// by its run id marker (the rail and a ⌘K message link both jump through it),
// scrolled to, and held there while a long thread's window fills it in. A fake
// ResizeObserver lets each test fire the row's resizes itself.
import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (typeof window === "undefined") GlobalRegistrator.register();

const { holdRunTurn, jumpToRunTurn } = await import("./message-scroller-rail");

function conversation(runIds: readonly string[]) {
  const container = document.createElement("div");
  container.getBoundingClientRect = () => ({ top: 20 }) as DOMRect;
  container.scrollTop = 100;
  runIds.forEach((runId, index) => {
    const turn = document.createElement("div");
    turn.dataset.runId = runId;
    turn.getBoundingClientRect = () => ({ top: 240 + index * 1000 }) as DOMRect;
    container.appendChild(turn);
  });
  return container;
}

describe("jumpToRunTurn", () => {
  test("scrolls the container to that run's turn with the rail's inset", () => {
    const container = conversation(["run-a", "run-b", "run-c"]);
    expect(jumpToRunTurn(container, "run-b")).toBe(true);
    expect(container.scrollTop).toBe(100 + 1240 - 20 - 8);
  });

  test("leaves the scroll alone when no turn of that run is rendered", () => {
    const container = conversation(["run-a"]);
    expect(jumpToRunTurn(container, "run-z")).toBe(false);
    expect(container.scrollTop).toBe(100);
  });
});

class FakeResizeObserver {
  static last: FakeResizeObserver | null = null;
  observed: Element[] = [];
  disconnected = false;
  constructor(readonly callback: () => void) {
    FakeResizeObserver.last = this;
  }
  observe(element: Element) {
    this.observed.push(element);
  }
  unobserve() {}
  disconnect() {
    this.disconnected = true;
  }
  fire() {
    if (!this.disconnected) this.callback();
  }
}

const realResizeObserver = globalThis.ResizeObserver;

afterEach(() => {
  globalThis.ResizeObserver = realResizeObserver;
  FakeResizeObserver.last = null;
});

/** A conversation of two turns; `moveTurnTo` moves the held one. */
function heldConversation() {
  globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
  const container = document.createElement("div");
  container.getBoundingClientRect = () => ({ top: 20 }) as DOMRect;
  container.scrollTop = 100;
  let turnTop = 28;
  const rows = ["run-a", "run-b"].map((runId) => {
    const row = document.createElement("div");
    row.dataset.runId = runId;
    row.getBoundingClientRect = () => ({ top: runId === "run-a" ? turnTop : turnTop + 400 }) as DOMRect;
    container.appendChild(row);
    return row;
  });
  document.body.appendChild(container);
  return {
    container,
    rows,
    moveTurnTo(top: number) {
      turnTop = top;
    },
  };
}

describe("holdRunTurn", () => {
  test("watches every turn and jumps back to the held one whenever one resizes", () => {
    const { container, rows, moveTurnTo } = heldConversation();
    const release = holdRunTurn(container, "run-a");
    const observer = FakeResizeObserver.last;
    expect(observer?.observed).toEqual(rows);

    // Rows above filled in and the window kept another row still: the turn moved down.
    moveTurnTo(60);
    observer?.fire();
    expect(container.scrollTop).toBe(100 + 60 - 20 - 8);
    // The window swapped it back to a shorter placeholder: it moved up.
    moveTurnTo(-300);
    observer?.fire();
    expect(container.scrollTop).toBe(132 - 300 - 20 - 8);
    release();
  });

  for (const type of ["wheel", "touchstart", "pointerdown", "keydown"]) {
    test(`lets go on ${type} anywhere on the page`, () => {
      const { container, moveTurnTo } = heldConversation();
      holdRunTurn(container, "run-a");
      const observer = FakeResizeObserver.last;
      document.body.dispatchEvent(new Event(type, { bubbles: true }));
      expect(observer?.disconnected).toBe(true);
      moveTurnTo(500);
      observer?.fire();
      expect(container.scrollTop).toBe(100);
    });
  }

  test("lets go on cleanup, and input after that changes nothing", () => {
    const { container } = heldConversation();
    const release = holdRunTurn(container, "run-a");
    const observer = FakeResizeObserver.last;
    release();
    expect(observer?.disconnected).toBe(true);
    window.dispatchEvent(new Event("wheel"));
  });
});
