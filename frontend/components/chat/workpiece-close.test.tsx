// Closing a Workspace tab: the pure decision, then the real close guard and tab
// strip with stand-in editors (the mounted editor registers the same handle).
// The answers go through the guard's `choose`, which the dialog's buttons call:
// the dialog itself portals through Radix, which other test files load before a
// DOM exists, so it cannot be counted on to mount in the full suite.
import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (typeof window === "undefined") GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { workpieceCloseStep } = await import("./workpiece-close");
const { useWorkpieceCloseGuard } = await import("./workpiece-close-guard");
type Guard = import("./workpiece-close-guard").WorkpieceCloseGuard;
const { WorkpieceTabStrip } = await import("./workspace-pane");

test("a clean tab closes at once, a tab with unsaved edits asks first", () => {
  expect(workpieceCloseStep({ dirty: false })).toBe("close");
  expect(workpieceCloseStep({ dirty: true })).toBe("ask");
  // Still loading, or failed to load: there is nothing to lose.
  expect(workpieceCloseStep(undefined)).toBe("close");
});

const TABS = [
  { id: "notes", name: "notes.md" },
  { id: "plan", name: "plan.md" },
];

interface FakeEditor {
  dirty: boolean;
  saves: number;
  /** What the save resolves to, or "throw" to reject. */
  saveResult: boolean | "throw";
  /** Holds the save until it resolves. */
  hold?: Promise<void>;
}

function mountGuard(editors: Record<string, FakeEditor>) {
  const closed: string[] = [];
  const selected: string[] = [];
  let current: Guard | null = null;
  let tabs: typeof TABS = TABS;
  function Harness() {
    const guard = useWorkpieceCloseGuard({
      tabs,
      onClose: (id) => closed.push(id),
      onSelect: (id) => selected.push(id),
    });
    current = guard;
    for (const [id, editor] of Object.entries(editors)) {
      guard.editors.set(id, {
        dirty: () => editor.dirty,
        save: async () => {
          editor.saves += 1;
          await editor.hold;
          if (editor.saveResult === "throw") throw new Error("network down");
          if (editor.saveResult) editor.dirty = false;
          return editor.saveResult;
        },
      });
    }
    return (
      <WorkpieceTabStrip
        tabs={tabs}
        activeId="notes"
        onSelect={() => {}}
        onClose={guard.requestClose}
      />
    );
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  return {
    closed,
    selected,
    asking: () => current?.asking?.name ?? null,
    saving: () => current?.saving ?? false,
    /** Re-renders with a different set of open tabs. */
    setTabs: (next: typeof TABS) => {
      tabs = next;
      return act(async () => root.render(<Harness />));
    },
    choose: (choice: Parameters<Guard["choose"]>[0]) =>
      act(async () => {
        await current?.choose(choice);
      }),
    /** Starts an answer and returns once React has rendered, without waiting for the save. */
    startChoose: async (choice: Parameters<Guard["choose"]>[0]) => {
      let pending: Promise<void> = Promise.resolve();
      await act(async () => {
        pending = current?.choose(choice) ?? Promise.resolve();
      });
      return () => act(async () => pending);
    },
    render: () => act(async () => root.render(<Harness />)),
    cleanup: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

const click = (el: Element | null | undefined) =>
  act(async () => {
    (el as HTMLElement | null)?.click();
  });
const closeButton = (name: string) => document.querySelector(`[aria-label="Close ${name}"]`);

afterEach(() => {
  document.body.innerHTML = "";
});

test("closing a clean tab closes it without asking", async () => {
  const ui = mountGuard({ notes: { dirty: false, saves: 0, saveResult: true } });
  await ui.render();
  await click(closeButton("notes.md"));
  expect(ui.asking()).toBeNull();
  expect(ui.closed).toEqual(["notes"]);
  await ui.cleanup();
});

test("closing a tab with unsaved edits asks, and Save stores them before closing", async () => {
  const notes = { dirty: true, saves: 0, saveResult: true };
  const ui = mountGuard({ notes });
  await ui.render();
  await click(closeButton("notes.md"));
  expect(ui.asking()).toBe("notes.md");
  expect(ui.closed).toEqual([]);

  await ui.choose("save");
  expect(notes.saves).toBe(1);
  expect(ui.closed).toEqual(["notes"]);
  expect(ui.asking()).toBeNull();
  await ui.cleanup();
});

test("Discard closes without saving", async () => {
  const notes = { dirty: true, saves: 0, saveResult: true };
  const ui = mountGuard({ notes });
  await ui.render();
  await click(closeButton("notes.md"));
  await ui.choose("discard");
  expect(notes.saves).toBe(0);
  expect(ui.closed).toEqual(["notes"]);
  await ui.cleanup();
});

test("Cancel keeps the tab and its edits", async () => {
  const notes = { dirty: true, saves: 0, saveResult: true };
  const ui = mountGuard({ notes });
  await ui.render();
  await click(closeButton("notes.md"));
  await ui.choose("cancel");
  expect(notes.saves).toBe(0);
  expect(ui.closed).toEqual([]);
  expect(ui.asking()).toBeNull();
  await ui.cleanup();
});

test("a save that fails keeps the tab open and brings it forward", async () => {
  const plan = { dirty: true, saves: 0, saveResult: false };
  const ui = mountGuard({ plan });
  await ui.render();
  await click(closeButton("plan.md"));
  await ui.choose("save");
  expect(plan.saves).toBe(1);
  expect(ui.closed).toEqual([]);
  expect(ui.selected).toEqual(["plan"]);
  await ui.cleanup();
});

test("edits that autosave stored while the dialog was open close without a second save", async () => {
  const notes = { dirty: true, saves: 0, saveResult: true };
  const ui = mountGuard({ notes });
  await ui.render();
  await click(closeButton("notes.md"));
  notes.dirty = false;
  await ui.choose("save");
  expect(notes.saves).toBe(0);
  expect(ui.closed).toEqual(["notes"]);
  await ui.cleanup();
});

test("a save that throws keeps the tab open, like a failed save", async () => {
  const notes: FakeEditor = { dirty: true, saves: 0, saveResult: "throw" };
  const ui = mountGuard({ notes });
  await ui.render();
  await click(closeButton("notes.md"));
  await ui.choose("save");
  expect(ui.closed).toEqual([]);
  expect(ui.selected).toEqual(["notes"]);
  expect(ui.saving()).toBe(false);
  await ui.cleanup();
});

test("a second answer while the save runs is ignored", async () => {
  let release = () => {};
  const notes: FakeEditor = {
    dirty: true,
    saves: 0,
    saveResult: true,
    hold: new Promise((resolve) => {
      release = resolve;
    }),
  };
  const ui = mountGuard({ notes });
  await ui.render();
  await click(closeButton("notes.md"));
  const finish = await ui.startChoose("save");
  expect(ui.saving()).toBe(true);
  await ui.startChoose("save");
  await ui.startChoose("discard");
  release();
  await finish();
  expect(notes.saves).toBe(1);
  expect(ui.closed).toEqual(["notes"]);
  await ui.cleanup();
});

test("a tab that went away during the save is not closed or selected again", async () => {
  let release = () => {};
  const notes: FakeEditor = {
    dirty: true,
    saves: 0,
    saveResult: true,
    hold: new Promise((resolve) => {
      release = resolve;
    }),
  };
  const ui = mountGuard({ notes });
  await ui.render();
  await click(closeButton("notes.md"));
  const finish = await ui.startChoose("save");
  await ui.setTabs([{ id: "plan", name: "plan.md" }]);
  release();
  await finish();
  expect(ui.closed).toEqual([]);
  expect(ui.selected).toEqual([]);
  expect(ui.asking()).toBeNull();
  await ui.cleanup();
});
