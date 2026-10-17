// The interaction half of the trace-controls tests: register happy-dom's
// globals BEFORE react-dom/client loads, mount the real TurnTrace, click its
// controls, and count what actually mounted. The static-markup tests beside
// this file could pass with an unbounded render hiding behind a click; these
// cannot — every number here is read off the live DOM after a user action.
import { describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (typeof window === "undefined") GlobalRegistrator.register();

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { TurnTrace, MAX_VISIBLE_TRACE_ROWS } = await import("./turn-trace");
const { ERROR_REVEAL_ROWS } = await import("./turn-trace-controls");

import type { TraceHeader, TraceRow, TraceStepRow } from "./turn-trace-model";

// happy-dom may not implement scrollIntoView; the jump must not depend on it.
if (typeof HTMLElement !== "undefined" && !("scrollIntoView" in HTMLElement.prototype)) {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    value: () => {},
    configurable: true,
    writable: true,
  });
}

const PROSE = { kind: "prose" as const, text: "Command output goes here" };
const HEADER: TraceHeader = { label: "Worked", detail: "ran 10,000 commands", failed: true };

function step(i: number, over: Partial<TraceStepRow> = {}): TraceStepRow {
  return {
    kind: "step",
    key: `s-${i}`,
    family: "shell",
    label: "Run",
    chip: null,
    detail: null,
    durationMs: null,
    status: "done",
    body: PROSE,
    ...over,
  };
}

function tenKRows(failedIndex: number, failedBody: TraceStepRow["body"] = PROSE): TraceRow[] {
  return Array.from({ length: 10_000 }, (_, i) =>
    step(i, {
      status: i === failedIndex ? "failed" : "done",
      body: i === failedIndex ? failedBody : PROSE,
    }),
  );
}

const roots: ReturnType<typeof createRoot>[] = [];

async function mount(rows: TraceRow[]): Promise<void> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(<TurnTrace rows={rows} header={HEADER} live={false} defaultOpen={true} />);
  });
}

async function teardown(): Promise<void> {
  for (const root of roots) {
    await act(async () => {
      root.unmount();
    });
  }
  roots.length = 0;
  document.body.textContent = "";
}

const click = async (label: string): Promise<void> => {
  const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!button) throw new Error(`control not found: ${label}`);
  await act(async () => {
    button.click();
  });
};

const clickLaterSteps = async (): Promise<void> => {
  const later = Array.from(document.querySelectorAll("button")).find((b) =>
    (b.textContent ?? "").includes("later steps"),
  );
  if (!later) throw new Error("later-steps affordance missing");
  await act(async () => {
    later.click();
  });
};

const rowCount = () => document.querySelectorAll('[data-testid="trace-row"]').length;
const payloadCount = () =>
  document.querySelectorAll(
    '[data-testid="trace-row-prose"], [data-testid="trace-row-failure"], [data-testid="trace-row-output"]',
  ).length;
const focusedRowKey = () =>
  document.activeElement?.closest("[data-row-key]")?.getAttribute("data-row-key") ?? null;
const buttonTexts = () =>
  Array.from(document.querySelectorAll("button")).map((b) => b.textContent ?? "");

describe("TurnTrace interactions on a 10,000-step trace", () => {
  test("jump to an EARLY failure mounts the bounded window, not the tail", async () => {
    const failed = 3;
    await mount(tenKRows(failed));
    try {
      // The default fold shows only the newest rows.
      expect(rowCount()).toBe(MAX_VISIBLE_TRACE_ROWS);
      await click("Jump to first error");
      // The view IS the window: the rows up to 24 past the failure, never the
      // 9,996 rows after it.
      expect(rowCount()).toBe(failed + 1 + ERROR_REVEAL_ROWS);
      expect(rowCount()).toBeLessThanOrEqual(ERROR_REVEAL_ROWS * 2 + 1);
      // Exactly one payload: the failed row the jump opened.
      expect(payloadCount()).toBe(1);
      // The rest of the trace stays folded behind an honest affordance.
      expect(
        buttonTexts().some((t) =>
          t.includes(`Show ${10_000 - (failed + 1 + ERROR_REVEAL_ROWS)} later steps`),
        ),
      ).toBe(true);
      // Focus landed on the failed row.
      expect(focusedRowKey()).toBe(`s-${failed}`);
    } finally {
      await teardown();
    }
  });

  test("jump to a MIDDLE failure mounts the window with folds on both sides", async () => {
    const failed = 5_000;
    await mount(tenKRows(failed));
    try {
      await click("Jump to first error");
      expect(rowCount()).toBe(ERROR_REVEAL_ROWS * 2 + 1);
      expect(payloadCount()).toBe(1);
      const texts = buttonTexts();
      expect(texts.some((t) => t.includes("Show 4976 earlier steps"))).toBe(true);
      expect(texts.some((t) => t.includes("Show 4975 later steps"))).toBe(true);
    } finally {
      await teardown();
    }
  });

  test("Expand all stays bounded: no click ever mounts 10,000 rows or payloads", async () => {
    await mount(tenKRows(3));
    try {
      await click("Expand all steps");
      // The fold stays put; expanding opens the shown rows' payloads only.
      expect(rowCount()).toBe(MAX_VISIBLE_TRACE_ROWS);
      expect(payloadCount()).toBe(MAX_VISIBLE_TRACE_ROWS);
      // Jumping after expanding keeps the same bound on rows.
      await click("Jump to first error");
      expect(rowCount()).toBeLessThanOrEqual(ERROR_REVEAL_ROWS * 2 + 1);
    } finally {
      await teardown();
    }
  });

  test("'Show N later steps' pages a bounded chunk per click", async () => {
    const failed = 3;
    await mount(tenKRows(failed));
    try {
      await click("Jump to first error");
      const afterJump = rowCount();
      for (let i = 1; i <= 3; i++) {
        await clickLaterSteps();
        expect(rowCount()).toBe(afterJump + i * ERROR_REVEAL_ROWS);
        expect(rowCount()).toBeLessThan(200);
      }
    } finally {
      await teardown();
    }
  });

  test("a failed row without a payload still takes the focus", async () => {
    const failed = 9_995; // inside the default newest-rows fold
    await mount(tenKRows(failed, null));
    try {
      await click("Jump to first error");
      const active = document.activeElement;
      expect(focusedRowKey()).toBe(`s-${failed}`);
      expect(active?.tagName).toBe("DIV");
      expect(active?.getAttribute("tabindex")).toBe("-1");
      expect(payloadCount()).toBe(0);
    } finally {
      await teardown();
    }
  });

  test("a failure-only trace with no payloads offers no no-op Expand all", async () => {
    await mount([
      step(0, { status: "failed", body: null }),
      step(1, { body: null }),
      step(2, { body: null }),
    ]);
    try {
      expect(document.querySelector('button[aria-label="Expand all steps"]')).toBeNull();
      expect(document.querySelector('button[aria-label="Jump to first error"]')).not.toBeNull();
    } finally {
      await teardown();
    }
  });
});
