import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionSample } from "./session-sample";

test("renders one synthetic session through the real timeline + chrome renderers", () => {
  // The tooltip provider is app-wide in app/providers.tsx; supply it here.
  const html = renderToStaticMarkup(
    <>
      <SessionSample />
    </>,
  );

  // Four turns => the message scroller rail has enough ticks to appear.
  const turns = html.match(/data-run-id="turn-/g) ?? [];
  expect(turns).toHaveLength(4);
  expect(html).toContain('data-session-ui="message-scroller-rail"');

  // The conversation runs through the REAL leaf renderers, not a fork.
  expect(html).toContain('data-testid="session-timeline"');
  expect(html).toContain(">Agent<");
  // A turn's work is ONE trace block; context receipts (playbook + memory +
  // knowledge recalls) and the memory write chip are its step lines.
  expect(html).toContain('data-testid="turn-trace"');
  expect(html).toContain('data-testid="trace-row"');
  expect(html).toContain("Recalled memory");
  expect(html).toContain("Recalled knowledge");
  expect(html).toContain("Activated playbook");
  expect(html).toContain("Remembered"); // memory write chip
  expect(html).toContain("rate-limit-diagram.png"); // artifact card below the answer

  // Adjacent surfaces render their real components.
  expect(html).toContain('data-session-ui="git-chips"');
  expect(html).toContain('data-session-ui="changed-files-card"');
  expect(html).toContain('data-session-ui="file-diff-view"');
  expect(html).toContain('data-session-ui="agent-panel-row"');
  expect(html).toContain('data-testid="todo-list"'); // plan / todo card

  // The left index is navigable.
  expect(html).toContain('aria-label="Covered types"');
  expect(html).toContain('href="#plan"');
});
