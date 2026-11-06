// The interaction half of the scroll-to-end tests: register happy-dom's
// globals BEFORE react-dom/client loads, mount the real ScrollToEndPill next
// to a stand-in composer, activate the pill, and read the live focus. The pill
// unmounts itself once the reader is at the end; a keyboard activation must
// keep focus in the reply box, while a pointer tap must not pull focus into it
// (an input focus opens the on-screen keyboard on phones).
import { expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (typeof window === "undefined") GlobalRegistrator.register();

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ScrollToEndPill } = await import("./scroll-to-end-pill");
import type { RefObject } from "react";

async function mountPill() {
  const composer = document.createElement("div");
  composer.setAttribute("data-session-ui", "reply-composer");
  const textarea = document.createElement("textarea");
  composer.appendChild(textarea);
  document.body.appendChild(composer);

  const scroller = document.createElement("div");
  document.body.appendChild(scroller);
  Object.defineProperty(scroller, "scrollHeight", { value: 500, configurable: true });
  Object.defineProperty(scroller, "clientHeight", { value: 200, configurable: true });
  Object.defineProperty(scroller, "scrollTop", {
    value: 0,
    writable: true,
    configurable: true,
  });
  const scrollRef: RefObject<HTMLElement | null> = { current: scroller };

  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<ScrollToEndPill scrollRef={scrollRef} />);
  });

  const pill = host.querySelector<HTMLButtonElement>('[data-session-ui="scroll-to-end"]');
  expect(pill).not.toBeNull();

  const cleanup = () => {
    root.unmount();
    composer.remove();
    scroller.remove();
  };
  return { pill: pill as HTMLButtonElement, scroller, textarea, cleanup };
}

test("keyboard activation jumps and keeps focus in the reply box", async () => {
  const { pill, scroller, textarea, cleanup } = await mountPill();

  // Enter/Space on a button fire a click with detail 0.
  await act(async () => {
    pill.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
  });

  expect(scroller.scrollTop).toBe(500);
  expect(document.activeElement).toBe(textarea);

  cleanup();
});

test("pointer tap jumps without pulling focus into the reply box", async () => {
  const { pill, scroller, textarea, cleanup } = await mountPill();

  // A mouse or touch tap fires a click with a non-zero detail.
  await act(async () => {
    pill.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
  });

  expect(scroller.scrollTop).toBe(500);
  expect(document.activeElement).not.toBe(textarea);

  cleanup();
});
