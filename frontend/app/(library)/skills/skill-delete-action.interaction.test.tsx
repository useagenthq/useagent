// The shared delete flow used by the skill detail dialog and the playbook
// detail. Mounted directly (no Modal, so no portal) under happy-dom, with the
// real skills-api over a stubbed fetch: confirming sends DELETE and then calls
// onDeleted (the caller's list refresh + close), a teammate's earlier delete
// (404) refreshes the same way, a refusal because automations still use it
// (409) names them in the confirm strip, and any other failure shows a plain
// line there.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (typeof window === "undefined") GlobalRegistrator.register();

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { SkillDeleteAction } = await import("./skill-delete-action");

const originalFetch = globalThis.fetch;
let calls: { url: string; method: string | undefined }[] = [];
let reply: () => Response = () => Response.json({ deleted: true, id: "k1" });

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLElement | null = null;

async function flush() {
  // Let the delete promise and the state updates it schedules settle.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
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
  const scope = inConfirm ? confirmStrip() : container;
  const match = Array.from(scope?.querySelectorAll("button") ?? []).find((el) =>
    (el.textContent ?? "").includes(label),
  );
  if (!match) throw new Error(`no button labelled ${label}`);
  return match as HTMLButtonElement;
}

function confirmStrip(): HTMLElement | null {
  return container?.querySelector('[data-testid="inline-delete-confirm"]') ?? null;
}

/** The problem line, which lives inside the confirm strip. */
function stripAlert(): string | null {
  return confirmStrip()?.querySelector('[role="alert"]')?.textContent ?? null;
}

async function click(el: HTMLButtonElement) {
  await act(async () => {
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
}

async function confirmDelete() {
  await click(button("Delete"));
  await click(button("Delete", true));
  await flush();
}

beforeEach(() => {
  calls = [];
  reply = () => Response.json({ deleted: true, id: "k1" });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method });
    return reply();
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
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

    expect(calls).toEqual([{ url: "/api/skills/k1", method: "DELETE" }]);
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

    expect(calls).toEqual([]);
    expect(refreshed).toBe(0);
    expect(confirmStrip()).toBeNull();
  });

  test("already deleted by a teammate refreshes the list instead of failing", async () => {
    reply = () => Response.json({ error: "skill not found" }, { status: 404 });
    let refreshed = 0;
    await mount(() => {
      refreshed += 1;
    });

    await confirmDelete();

    expect(refreshed).toBe(1);
    expect(confirmStrip()).toBeNull();
    expect(container?.querySelector('[role="alert"]')).toBeNull();
  });

  test("still used by enabled automations: the strip names them and says what to do", async () => {
    reply = () =>
      Response.json(
        {
          error: "skill_in_use",
          used_by: [
            { name: "Nightly digest", bot: null },
            { name: "Weekly metrics", bot: "Ledger" },
          ],
          total: 2,
        },
        { status: 409 },
      );
    let refreshed = 0;
    await mount(() => {
      refreshed += 1;
    });

    await confirmDelete();

    expect(refreshed).toBe(0);
    expect(stripAlert()).toBe(
      "Nightly digest and Weekly metrics (Ledger's routine) still use this. Pause them or change what they use, then delete.",
    );
  });

  test("one holder reads in the singular, and many are counted past the named few", async () => {
    reply = () =>
      Response.json({ error: "skill_in_use", used_by: [{ name: "Nightly digest", bot: null }], total: 1 }, { status: 409 });
    await mount(() => {});
    await confirmDelete();
    expect(stripAlert()).toBe("Nightly digest still uses this. Pause it or change what it uses, then delete.");

    reply = () =>
      Response.json(
        {
          error: "skill_in_use",
          used_by: ["A", "B", "C", "D", "E"].map((name) => ({ name, bot: null })),
          total: 7,
        },
        { status: 409 },
      );
    await click(button("Delete", true));
    await flush();
    expect(stripAlert()).toBe("A, B, C, D, E, and 2 more still use this. Pause them or change what they use, then delete.");
  });

  test("a failed delete shows a plain line in the strip and does not refresh", async () => {
    reply = () => new Response("boom", { status: 500 });
    let refreshed = 0;
    await mount(() => {
      refreshed += 1;
    });

    await confirmDelete();

    expect(calls).toEqual([{ url: "/api/skills/k1", method: "DELETE" }]);
    expect(refreshed).toBe(0);
    expect(stripAlert()).toBe("Couldn't delete this right now. Try again in a moment.");
    // Still confirming, so the user can retry after the error.
    expect(confirmStrip()).not.toBeNull();
  });
});
