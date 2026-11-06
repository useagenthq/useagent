// The side panel sheet's focus rules, driven through the real hook in a live
// DOM: keys are real keydown events and focus is read off document.activeElement.
import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (typeof window === "undefined") GlobalRegistrator.register();

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act, useEffect, useRef } = await import("react");
const { createRoot } = await import("react-dom/client");
const { sheetDialogProps, useSheetDialog } = await import("./use-sheet-dialog");

const ignore = () => {};

/** A thread bar opener, a conversation control and a sheet with a hidden pane. */
/** Takes focus from an effect, the way the composer does when a sheet seeds it. */
function Composer({ takeFocus }: { takeFocus: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (takeFocus) ref.current?.focus();
  }, [takeFocus]);
  return <textarea ref={ref} data-testid="composer" />;
}

function Harness({ open, mounted = true, inert = false, onDismiss = ignore, seedComposer = false }: {
  open: boolean;
  mounted?: boolean;
  inert?: boolean;
  onDismiss?: () => void;
  seedComposer?: boolean;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const fallbackRef = useRef<HTMLButtonElement>(null);
  useSheetDialog(open, dialogRef, fallbackRef, onDismiss);
  return (
    <>
      <button type="button" ref={fallbackRef} data-testid="thread-opener">
        Open
      </button>
      <button type="button" data-testid="link-in-conversation">
        Open file
      </button>
      <Composer takeFocus={seedComposer} />
      {mounted ? (
        <section ref={dialogRef} tabIndex={-1} role="dialog" inert={inert} data-testid="sheet">
          <button type="button" data-testid="tab">
            Files
          </button>
          <button type="button" disabled>
            Disabled
          </button>
          <div aria-hidden="true">
            <button type="button">In a hidden pane</button>
          </div>
          <button type="button" style={{ display: "none" }}>
            Expand, not shown on a phone
          </button>
          <div data-testid="nested" role="dialog">
            <button type="button" data-testid="in-nested">
              Collapse
            </button>
          </div>
          <button type="button" data-testid="close">
            Close
          </button>
        </section>
      ) : null}
    </>
  );
}

const byId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`) as HTMLElement;

function pressTab(
  target: EventTarget,
  shiftKey = false,
  prepare?: (event: KeyboardEvent) => void,
  ctrlKey = false,
) {
  const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey, ctrlKey, bubbles: true, cancelable: true });
  prepare?.(event);
  target.dispatchEvent(event);
  return event;
}

let cleanup: (() => void) | null = null;

function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  cleanup = () => {
    act(() => root.unmount());
    host.remove();
  };
  return (ui: React.ReactNode) => act(() => root.render(ui));
}

afterEach(() => {
  cleanup?.();
  cleanup = null;
  (document.activeElement as HTMLElement | null)?.blur?.();
});

describe("useSheetDialog", () => {
  test("moves focus into the sheet when it opens", () => {
    const render = mount();
    render(<Harness open={false} />);
    byId("thread-opener").focus();

    render(<Harness open />);

    expect(document.activeElement).toBe(byId("sheet"));
  });

  test("leaves focus alone while the sheet is closed", () => {
    const render = mount();
    render(<Harness open={false} />);
    byId("link-in-conversation").focus();

    expect(pressTab(byId("link-in-conversation")).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(byId("link-in-conversation"));
  });

  test("Tab wraps from the last control to the first, skipping what cannot take focus", () => {
    const render = mount();
    render(<Harness open />);
    byId("close").focus();

    const event = pressTab(byId("close"));

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(byId("tab"));
  });

  test("a hidden pane after the last control does not move the edge", () => {
    const render = mount();
    render(<Harness open />);
    const hiddenPane = document.createElement("div");
    hiddenPane.setAttribute("aria-hidden", "true");
    hiddenPane.innerHTML = "<button>In a hidden pane</button>";
    byId("sheet").appendChild(hiddenPane);
    const hiddenButton = document.createElement("button");
    hiddenButton.style.display = "none";
    byId("sheet").appendChild(hiddenButton);
    byId("close").focus();

    pressTab(byId("close"));

    expect(document.activeElement).toBe(byId("tab"));
    hiddenPane.remove();
    hiddenButton.remove();
  });

  test("Shift+Tab wraps from the first control, and from the sheet itself, to the last", () => {
    const render = mount();
    render(<Harness open />);

    // Where focus lands on open: without this Shift+Tab leaves the sheet at once.
    expect(document.activeElement).toBe(byId("sheet"));
    pressTab(byId("sheet"), true);
    expect(document.activeElement).toBe(byId("close"));

    byId("tab").focus();
    pressTab(byId("tab"), true);
    expect(document.activeElement).toBe(byId("close"));
  });

  test("Tab between the edges stays with the browser", () => {
    const render = mount();
    render(<Harness open />);
    byId("tab").focus();

    expect(pressTab(byId("tab")).defaultPrevented).toBe(false);
  });

  test("pulls focus back in when the focused control went away", () => {
    const render = mount();
    render(<Harness open />);
    (document.activeElement as HTMLElement).blur();

    pressTab(document.body);

    expect(document.activeElement).toBe(byId("tab"));
  });

  test("yields Tab to a pane that handled it, such as the terminal", () => {
    const render = mount();
    render(<Harness open />);
    byId("close").focus();

    pressTab(byId("close"), false, (event) => event.preventDefault());

    expect(document.activeElement).toBe(byId("close"));
  });

  test("yields to a dialog nested in the sheet and to a popover outside it", () => {
    const render = mount();
    render(<Harness open />);

    // The nested dialog's control is the sheet's last one, so an edge check that
    // ignored the nesting would wrap it to a control the nested dialog made inert.
    byId("sheet").appendChild(byId("nested"));
    byId("in-nested").focus();
    expect(pressTab(byId("in-nested")).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(byId("in-nested"));

    const popover = document.createElement("button");
    document.body.appendChild(popover);
    popover.focus();
    expect(pressTab(popover).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(popover);
    popover.remove();
  });

  test("closing returns focus to the control that opened it", () => {
    const render = mount();
    render(<Harness open={false} />);
    byId("link-in-conversation").focus();
    render(<Harness open />);

    // The rail unmounts when it closes.
    render(<Harness open={false} mounted={false} />);

    expect(document.activeElement).toBe(byId("link-in-conversation"));
  });

  test("closing goes to the fallback when nothing held focus at open (a tap on iOS)", () => {
    const render = mount();
    render(<Harness open={false} />);
    expect(document.activeElement).toBe(document.body);
    render(<Harness open />);

    render(<Harness open={false} mounted={false} />);

    expect(document.activeElement).toBe(byId("thread-opener"));
  });

  test("closing goes to the fallback when the opener left the page", () => {
    const render = mount();
    render(<Harness open={false} />);
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    render(<Harness open />);
    opener.remove();

    render(<Harness open={false} mounted={false} />);

    expect(document.activeElement).toBe(byId("thread-opener"));
  });

  test("returns focus when the sheet stays mounted but turns inert", () => {
    const render = mount();
    render(<Harness open={false} />);
    byId("link-in-conversation").focus();
    render(<Harness open />);

    render(<Harness open={false} inert />);

    expect(document.activeElement).toBe(byId("link-in-conversation"));
  });

  test("keeps focus in the panel when widening the window ends the sheet", () => {
    const render = mount();
    render(<Harness open={false} />);
    byId("link-in-conversation").focus();
    render(<Harness open />);
    byId("tab").focus();

    render(<Harness open={false} />);

    expect(document.activeElement).toBe(byId("tab"));
  });

  test("stops handling Tab after it closes", () => {
    const render = mount();
    render(<Harness open />);
    render(<Harness open={false} />);
    byId("close").focus();

    expect(pressTab(byId("close")).defaultPrevented).toBe(false);
  });

  test("Escape dismisses the sheet only while it is open", () => {
    let dismissed = 0;
    const onDismiss = () => {
      dismissed += 1;
    };
    const pressEscape = () =>
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    const render = mount();
    render(<Harness open={false} onDismiss={onDismiss} />);

    pressEscape();
    expect(dismissed).toBe(0);

    render(<Harness open onDismiss={onDismiss} />);
    pressEscape();
    expect(dismissed).toBe(1);
  });

  test("an Escape a layer above already used leaves the sheet open", () => {
    let dismissed = 0;
    const render = mount();
    render(<Harness open onDismiss={() => (dismissed += 1)} />);
    // The command palette claims its Escape in the capture phase.
    const claim = (event: Event) => event.preventDefault();
    document.addEventListener("keydown", claim, true);

    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    document.removeEventListener("keydown", claim, true);

    expect(dismissed).toBe(0);
  });

  test("brings back focus that lands on the page behind the sheet", () => {
    const render = mount();
    render(<Harness open />);

    // A closing nav drawer hands focus back to its trigger.
    byId("thread-opener").focus();

    expect(document.activeElement).toBe(byId("sheet"));
  });

  test("hides the page from screen readers only while open", () => {
    const render = mount();
    render(<Harness open={false} />);
    const live = document.createElement("div");
    live.setAttribute("aria-live", "polite");
    document.body.appendChild(live);
    expect(byId("link-in-conversation").getAttribute("aria-hidden")).toBeNull();

    render(<Harness open />);
    expect(byId("link-in-conversation").getAttribute("aria-hidden")).toBe("true");
    expect(byId("sheet").getAttribute("aria-hidden")).toBeNull();
    expect(live.getAttribute("aria-hidden")).toBeNull();

    render(<Harness open={false} />);
    expect(byId("link-in-conversation").getAttribute("aria-hidden")).toBeNull();
    live.remove();
  });

  test("leaves browser Ctrl+Tab alone", () => {
    const render = mount();
    render(<Harness open />);
    byId("close").focus();

    expect(pressTab(byId("close"), false, undefined, true).defaultPrevented).toBe(false);
  });

  test("a control seeded in the same close keeps focus over the opener", () => {
    const render = mount();
    render(<Harness open={false} />);
    byId("link-in-conversation").focus();
    render(<Harness open />);

    render(<Harness open={false} mounted={false} seedComposer />);

    expect(document.activeElement).toBe(byId("composer"));
  });

  test("an Escape a nested layer stopped does not reach the sheet", () => {
    let dismissed = 0;
    const onDismiss = () => {
      dismissed += 1;
    };
    const render = mount();
    render(<Harness open onDismiss={onDismiss} />);
    const nested = byId("nested");
    const stop = (event: Event) => event.stopPropagation();
    nested.addEventListener("keydown", stop);

    byId("in-nested").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(dismissed).toBe(0);
    nested.removeEventListener("keydown", stop);
  });

  test("describes a dialog only while open, so the side by side panel stays a region", () => {
    expect(sheetDialogProps(true, "Side panel")).toEqual({
      role: "dialog",
      "aria-modal": true,
      "aria-label": "Side panel",
      tabIndex: -1,
    });
    expect(sheetDialogProps(false, "Side panel")).toEqual({});
  });

  test("keeps focus already inside the sheet when it opens", () => {
    const render = mount();
    render(<Harness open={false} />);
    byId("tab").focus();

    render(<Harness open />);

    expect(document.activeElement).toBe(byId("tab"));
  });
});
