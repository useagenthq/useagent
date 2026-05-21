import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import * as Tooltip from "@/components/ui/tooltip";
import { T3TimelineShowcase } from "./t3-timeline-showcase";

test("renders every ported t3-ui piece from mock canonical nodes", () => {
  // The app mounts TooltipProvider in app/providers.tsx; mirror it here.
  const html = renderToStaticMarkup(
    <Tooltip.Provider>
      <T3TimelineShowcase />
    </Tooltip.Provider>,
  );

  // All five mock tool nodes + thinking + running render as compact work rows.
  const rows = html.match(/data-t3-ui="work-entry-row"/g) ?? [];
  expect(rows.length).toBeGreaterThanOrEqual(7);

  // Adapter grammar: verbs from OUR deriveTrace, previews from the T3 precedence.
  expect(html).toContain("Read");
  expect(html).toContain("page.tsx");
  expect(html).toContain("bun test provider-gateway");
  expect(html).toContain("Create issue");
  expect(html).toContain("Thinking");

  // Failure affordance from the ported status heuristics (exit 1 + error output).
  expect(html).toContain('aria-label="Failed"');
  expect(html).toContain('aria-label="Completed"');

  // Work group folds all but the newest row behind the upstream toggle copy.
  expect(html).toContain('data-t3-ui="work-group"');
  expect(html).toContain("+4 previous tool calls");

  // Working indicator + sync pill.
  expect(html).toContain('data-t3-ui="working-indicator"');
  expect(html).toContain("Working for");
  expect(html).toContain('data-t3-ui="sync-status-pill"');
  expect(html).toContain("Catching up on this thread");
});
