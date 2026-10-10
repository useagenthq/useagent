import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TraceControlsBar, type TraceControlsModel } from "./turn-trace-controls";
import {
  anyStepExpanded,
  applyAllSteps,
  traceControlsModel,
} from "./turn-trace-controls";
import { TraceRowView, TurnTrace } from "./turn-trace";
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
        canJump={true}
        onToggleAll={() => {}}
        onJumpToError={() => {}}
      />,
    );
    expect(html).toContain('aria-label="Collapse all steps"');
    expect(html).toContain(">Collapse all<");
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
