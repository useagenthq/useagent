// Mounts the real AgentAnnouncer in happy-dom and drives the props through the
// transitions a thread goes through, checking the live region off the DOM. The
// pure rule is unit-tested separately; this covers the region itself - polite
// status, one sentence per event, and re-reading an identical one.
import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (typeof window === "undefined") GlobalRegistrator.register();

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AgentAnnouncer } = await import("./agent-announcer");

import type { ComponentProps } from "react";

type Props = ComponentProps<typeof AgentAnnouncer>;

const IDLE: Props = {
  running: false,
  outcome: null,
  approvalId: null,
  questionId: null,
  pendingApprovalIds: [],
};

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLElement | null = null;

function mount(props: Props) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<AgentAnnouncer {...props} />));
}

function rerender(props: Props) {
  act(() => root?.render(<AgentAnnouncer {...props} />));
}

function region(): HTMLElement {
  const el = container?.querySelector('[role="status"]') as HTMLElement | null;
  if (!el) throw new Error("live region did not render");
  return el;
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("AgentAnnouncer", () => {
  test("renders a visually hidden polite, atomic status region", () => {
    mount(IDLE);
    const el = region();
    expect(el.getAttribute("aria-live")).toBe("polite");
    expect(el.getAttribute("aria-atomic")).toBe("true");
    expect(el.className).toContain("sr-only");
    // Nothing is announced on the baseline render.
    expect(el.textContent).toBe("");
  });

  test("announces a finished reply once, not the baseline", () => {
    mount({ ...IDLE, running: true });
    expect(region().textContent).toBe("");
    rerender({ ...IDLE, outcome: "replied" });
    expect(region().textContent).toBe("The agent replied.");
  });

  test("announces a newly waiting approval, and never streams tokens", () => {
    mount({ ...IDLE, running: true });
    rerender({ ...IDLE, running: true, approvalId: "ap1" });
    expect(region().textContent).toBe("The agent needs your approval.");
    // Resolving it does not re-announce or leave stale text as a new event.
    rerender({ ...IDLE, running: true });
    expect(region().textContent).toBe("The agent needs your approval.");
  });

  test("a second identical approval is announced again (keyed remount)", () => {
    mount({ ...IDLE, running: true });
    rerender({ ...IDLE, running: true, approvalId: "ap1" });
    const firstSpan = region().querySelector("span");
    expect(firstSpan?.textContent).toBe("The agent needs your approval.");
    rerender({ ...IDLE, running: true });
    rerender({ ...IDLE, running: true, approvalId: "ap2" });
    expect(region().textContent).toBe("The agent needs your approval.");
    // New DOM node the second time, so the screen reader reads it again.
    const secondSpan = region().querySelector("span");
    expect(secondSpan).not.toBe(firstSpan);
  });
});
