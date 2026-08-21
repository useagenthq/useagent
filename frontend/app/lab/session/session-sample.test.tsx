import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import * as Tooltip from "@/components/ui/tooltip";
import { SessionSample } from "./session-sample";

test("renders one synthetic session through the real timeline + chrome renderers", () => {
  // The AlignUI tooltip provider is app-wide in app/providers.tsx; supply it here.
  const html = renderToStaticMarkup(
    <Tooltip.Provider>
      <SessionSample />
    </Tooltip.Provider>,
  );

  // Four turns => the message scroller rail has enough ticks to appear.
  const turns = html.match(/data-run-id="turn-/g) ?? [];
  expect(turns).toHaveLength(4);
  expect(html).toContain('data-session-ui="message-scroller-rail"');

  // The conversation runs through the REAL leaf renderers, not a fork.
  expect(html).toContain('data-testid="session-timeline"');
  expect(html).toContain(">Agent<");
  // Leading context receipts (skill + memory + knowledge) minify into ONE quiet
  // fold; its collapsed summary states the counts.
  expect(html).toContain('data-session-ui="context-recall-fold"');
  expect(html).toContain("3 memory, 5 knowledge, 1 playbook");
  // Non-recall markers stay as their own rows (the memory write chip, the
  // reconcile marker) - the marker-row probe still resolves.
  expect(html).toContain('data-testid="marker-row"');
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
