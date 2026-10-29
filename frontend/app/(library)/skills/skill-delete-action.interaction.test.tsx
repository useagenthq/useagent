// The shared delete flow used by the skill detail dialog and the playbook
// detail. Mounted directly (no Modal, so no portal) under happy-dom: confirming
// calls deleteSkill and then onDeleted (the caller's list refresh + close),
// Cancel leaves it untouched, and a failed delete shows a plain error line.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (typeof window === "undefined") GlobalRegistrator.register();

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let deleteCalls: string[] = [];
let deleteShouldFail = false;

// Dispatch through a per-file globalThis hook: bun shares one module registry
// across test files, so the last mock of this module wins for every importer.
type SkillsApiHook = { deleteSkill: (id: string) => Promise<void> };
const hookHolder = globalThis as unknown as { __skillsApiHook?: SkillsApiHook };

mock.module("@/app/(library)/skills/skills-api", () => ({
  deleteSkill: (id: string) => hookHolder.__skillsApiHook?.deleteSkill(id),
}));

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { SkillDeleteAction } = await import("./skill-delete-action");

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLElement | null = null;

async function flush() {
  // Let the delete promise and the state updates it schedules settle.
  await act(async () => {
    await Promise.resolve();
  });
}

async function mount(onDeleted: () => void | Promise<void>) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <SkillDeleteAction
        skillId="k1"
        question="Delete this skill?"
        consequence="It leaves your library."
        onDeleted={onDeleted}
      />,
    );
  });
}

/** First button whose label contains `label`, scoped to the confirm strip when
 *  asked so the trigger Delete and the strip's Delete don't collide. */
function button(label: string, inConfirm = false): HTMLButtonElement {
  const scope = inConfirm
    ? (container?.querySelector('[data-testid="inline-delete-confirm"]') as HTMLElement | null)
    : container;
  const match = Array.from(scope?.querySelectorAll("button") ?? []).find((el) =>
    (el.textContent ?? "").includes(label),
  );
  if (!match) throw new Error(`no button labelled ${label}`);
  return match as HTMLButtonElement;
}

function confirmStrip(): HTMLElement | null {
  return container?.querySelector('[data-testid="inline-delete-confirm"]') ?? null;
}

async function click(el: HTMLButtonElement) {
  await act(async () => {
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  deleteCalls = [];
  deleteShouldFail = false;
  hookHolder.__skillsApiHook = {
    deleteSkill: async (id: string) => {
      deleteCalls.push(id);
      if (deleteShouldFail) throw new Error("delete skill 500");
    },
  };
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("SkillDeleteAction", () => {
  test("confirming deletes the skill and asks the caller to refresh", async () => {
    let refreshed = 0;
    await mount(() => {
      refreshed += 1;
    });

    // The confirm strip only appears after the Delete trigger is pressed.
    expect(confirmStrip()).toBeNull();
    await click(button("Delete"));
    expect(confirmStrip()).not.toBeNull();

    await click(button("Delete", true));
    await flush();

    expect(deleteCalls).toEqual(["k1"]);
    expect(refreshed).toBe(1);
    // The flow finished, so the confirm strip is gone again.
    expect(confirmStrip()).toBeNull();
  });

  test("Cancel leaves the skill untouched", async () => {
    let refreshed = 0;
    await mount(() => {
      refreshed += 1;
    });

    await click(button("Delete"));
    await click(button("Cancel", true));

    expect(deleteCalls).toEqual([]);
    expect(refreshed).toBe(0);
    expect(confirmStrip()).toBeNull();
  });

  test("a failed delete shows a plain error line and does not refresh", async () => {
    deleteShouldFail = true;
    let refreshed = 0;
    await mount(() => {
      refreshed += 1;
    });

    await click(button("Delete"));
    await click(button("Delete", true));
    await flush();

    expect(deleteCalls).toEqual(["k1"]);
    expect(refreshed).toBe(0);
    const alert = container?.querySelector('[role="alert"]');
    expect(alert?.textContent ?? "").toContain("Delete failed");
    // Still confirming, so the user can retry after the error.
    expect(confirmStrip()).not.toBeNull();
  });
});
