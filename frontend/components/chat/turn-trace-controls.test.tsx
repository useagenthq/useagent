import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TraceRowView, TurnTrace } from "./turn-trace";
import {
  anyStepExpanded,
  applyAllSteps,
  boundedErrorReveal,
  ERROR_REVEAL_ROWS,
  extendRevealForward,
  TraceControlsBar,
  type TraceControlsModel,
  traceControlsModel,
} from "./turn-trace-controls";
import type { TraceHeader, TraceRow, TraceStepRow } from "./turn-trace-model";

function step(over: Partial<TraceStepRow>): TraceStepRow {
  return {
    kind: "step",
    key: "step",
    family: "shell",
    label: "Run",
    chip: null,
    detail: null,
    durationMs: null,
    status: "done",
    body: null,
    ...over,
  };
}

const PROSE = { kind: "prose" as const, text: "Command output goes here" };

const ROWS: TraceRow[] = [
  step({ key: "run-1", body: PROSE }),
  step({ key: "run-2", body: PROSE }),
  { kind: "narration", key: "note-1", text: "Mid-work narration" },
  step({ key: "run-failed", status: "failed", body: PROSE }),
];

const HEADER: TraceHeader = { label: "Worked", detail: "ran 3 commands", failed: true };

describe("trace controls model", () => {
  test("collects the expandable keys and the first failed step", () => {
    const model = traceControlsModel(ROWS);
    expect(model.expandableKeys).toEqual(["run-1", "run-2", "run-failed"]);
    expect(model.firstFailedKey).toBe("run-failed");
  });

  test("no failed step means no jump target", () => {
    const model = traceControlsModel([step({ key: "run-1", body: PROSE })]);
    expect(model.firstFailedKey).toBeNull();
  });

  test("the first failure wins over a later one", () => {
    const model = traceControlsModel([
      step({ key: "fail-a", status: "failed" }),
      step({ key: "fail-b", status: "failed" }),
    ]);
    expect(model.firstFailedKey).toBe("fail-a");
  });
});

describe("bounded error reveal", () => {
  const tenK: TraceRow[] = Array.from({ length: 10_000 }, (_, i) =>
    step({ key: `s-${i}`, body: PROSE, status: i === 5_000 ? "failed" : "done" }),
  );

  test("jumping bounds the reveal to a window around the error, not the trace", () => {
    const win = boundedErrorReveal(tenK, "s-5000");
    expect(win).toEqual({ from: 5_000 - ERROR_REVEAL_ROWS, to: 5_001 + ERROR_REVEAL_ROWS });
    if (win) expect(win.to - win.from).toBeLessThan(60);
  });

  test("the window clamps at the row range's edges", () => {
    expect(boundedErrorReveal(tenK, "s-3")).toEqual({ from: 0, to: 3 + 1 + ERROR_REVEAL_ROWS });
    expect(boundedErrorReveal(tenK, "s-9999")).toEqual({
      from: 9_999 - ERROR_REVEAL_ROWS,
      to: 10_000,
    });
  });

  test("walking forward pages a bounded chunk per click, never to the edge", () => {
    const start = boundedErrorReveal(tenK, "s-3");
    if (!start) throw new Error("unreachable");
    let win = start;
    for (let i = 0; i < 5; i++) {
      win = extendRevealForward(win, tenK.length);
      expect(win.from).toBe(0);
      expect(win.to - win.from).toBeLessThan(start.to - start.from + 6 * ERROR_REVEAL_ROWS);
      expect(win.to).toBeLessThan(tenK.length);
    }
    // The edge clamps and stays clamped.
    const last = extendRevealForward({ from: 0, to: tenK.length - 1 }, tenK.length);
    expect(last).toEqual({ from: 0, to: tenK.length });
    expect(extendRevealForward(last, tenK.length)).toEqual(last);
  });

  test("a key outside the rows reveals nothing", () => {
    expect(boundedErrorReveal(tenK, "missing")).toBeNull();
  });

  test("two traces each carry their own scoped subtree for the jump lookup", () => {
    const failed = [step({ key: "failure", status: "failed", body: PROSE })];
    const html =
      renderToStaticMarkup(
        <TurnTrace rows={failed} header={HEADER} live={false} defaultOpen={true} />,
      ) +
      renderToStaticMarkup(
        <TurnTrace rows={failed} header={HEADER} live={false} defaultOpen={true} />,
      );
    // The duplicated key is exactly why the lookup is scoped to one trace's
    // section ref (TurnTrace) rather than the document.
    expect(html.split('data-row-key="failure"').length - 1).toBe(2);
    expect(html.split('data-testid="turn-trace"').length - 1).toBe(2);
  });
});

describe("toggle state", () => {
  const model: TraceControlsModel = traceControlsModel(ROWS);

  test("nothing expanded reads as collapsed", () => {
    expect(anyStepExpanded({}, model)).toBe(false);
    expect(anyStepExpanded({ "run-1": false, "run-2": false }, model)).toBe(false);
  });

  test("one open step reads as expanded", () => {
    expect(anyStepExpanded({ "run-2": true }, model)).toBe(true);
  });

  test("applyAllSteps sets every expandable step and keeps unrelated keys", () => {
    const next = applyAllSteps({ unrelated: true, "run-1": false }, model, true);
    expect(next["run-1"]).toBe(true);
    expect(next["run-2"]).toBe(true);
    expect(next["run-failed"]).toBe(true);
    expect(next.unrelated).toBe(true);
    expect(applyAllSteps(next, model, false)["run-2"]).toBe(false);
  });
});

describe("TraceControlsBar", () => {
  test("collapsed state offers Expand all; no failure means no jump control", () => {
    const html = renderToStaticMarkup(
      <TraceControlsBar
        anyExpanded={false}
        canToggleAll={true}
        canJump={false}
        onToggleAll={() => {}}
        onJumpToError={() => {}}
      />,
    );
    expect(html).toContain('aria-label="Expand all steps"');
    expect(html).toContain(">Expand all<");
    expect(html).not.toContain("Jump to error");
  });

  test("expanded state offers Collapse all, and a failure adds Jump to error", () => {
    const html = renderToStaticMarkup(
      <TraceControlsBar
        anyExpanded={true}
        canToggleAll={true}
        canJump={true}
        onToggleAll={() => {}}
        onJumpToError={() => {}}
      />,
    );
    expect(html).toContain('aria-label="Collapse all steps"');
    expect(html).toContain(">Collapse all<");
    expect(html).toContain('aria-label="Jump to first error"');
  });

  test("a turn with nothing to expand gets no no-op all-toggle", () => {
    const html = renderToStaticMarkup(
      <TraceControlsBar
        anyExpanded={false}
        canToggleAll={false}
        canJump={true}
        onToggleAll={() => {}}
        onJumpToError={() => {}}
      />,
    );
    expect(html).not.toContain("Expand all");
    expect(html).not.toContain("Collapse all");
    expect(html).toContain('aria-label="Jump to first error"');
  });
});

describe("TraceRowView controlled payload", () => {
  const row = step({ key: "run-1", body: PROSE });
  const toggle = () => {};

  test("collapsed mounts no payload and reports aria-expanded false", () => {
    const html = renderToStaticMarkup(
      <TraceRowView row={row} expanded={false} onToggle={toggle} highlighted={false} />,
    );
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Command output goes here");
    expect(html).not.toContain("data-highlight");
  });

  test("expanded mounts the payload", () => {
    const html = renderToStaticMarkup(
      <TraceRowView row={row} expanded={true} onToggle={toggle} highlighted={false} />,
    );
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("Command output goes here");
  });

  test("a highlighted row carries the data flag and its key", () => {
    const html = renderToStaticMarkup(
      <TraceRowView row={row} expanded={false} onToggle={toggle} highlighted={true} />,
    );
    expect(html).toContain('data-row-key="run-1"');
    expect(html).toContain('data-highlight="true"');
  });
});

describe("TurnTrace controls", () => {
  test("the trace mounts the controls, the jump target carries its key", () => {
    const html = renderToStaticMarkup(
      <TurnTrace rows={ROWS} header={HEADER} live={false} defaultOpen={true} />,
    );
    expect(html).toContain('data-testid="trace-controls"');
    expect(html).toContain('aria-label="Expand all steps"');
    expect(html).toContain('aria-label="Jump to first error"');
    expect(html).toContain('data-row-key="run-failed"');
  });

  test("a failed step is what makes the jump control render", () => {
    const html = renderToStaticMarkup(
      <TurnTrace
        rows={[step({ key: "run-1", body: PROSE })]}
        header={{ label: "Worked", detail: null, failed: false }}
        live={false}
        defaultOpen={true}
      />,
    );
    expect(html).toContain('data-testid="trace-controls"');
    expect(html).not.toContain("Jump to error");
  });

  test("a trace with nothing to expand and no failure renders no controls", () => {
    const html = renderToStaticMarkup(
      <TurnTrace
        rows={[step({ key: "run-1", body: null })]}
        header={{ label: "Worked", detail: null, failed: false }}
        live={false}
        defaultOpen={true}
      />,
    );
    expect(html).not.toContain('data-testid="trace-controls"');
  });

  test("a folded trace keeps its controls out of the DOM until opened", () => {
    const html = renderToStaticMarkup(
      <TurnTrace rows={ROWS} header={HEADER} live={false} defaultOpen={false} />,
    );
    expect(html).not.toContain('data-testid="trace-controls"');
    expect(html).toContain('aria-expanded="false"');
  });
});
