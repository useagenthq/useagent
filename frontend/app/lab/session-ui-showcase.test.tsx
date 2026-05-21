import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import * as Tooltip from "@/components/ui/tooltip";
import { TimelineShowcase } from "./session-ui-showcase";

test("renders every ported session-ui piece from mock canonical nodes", () => {
  // The app mounts TooltipProvider in app/providers.tsx; mirror it here.
  const html = renderToStaticMarkup(
    <Tooltip.Provider>
      <TimelineShowcase />
    </Tooltip.Provider>,
  );

  // All five mock tool nodes + thinking + running render as compact work rows.
  const rows = html.match(/data-session-ui="work-entry-row"/g) ?? [];
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
  expect(html).toContain('data-session-ui="work-group"');
  expect(html).toContain("+4 previous tool calls");

  // Worked-for fold: duration derived from the staggered mock node timestamps
  // (5 nodes, 9s apart -> 36s), shown collapsed AND expanded.
  expect(html).toContain('data-session-ui="worked-for-fold"');
  expect(html).toContain("Worked for 36s");
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain('aria-expanded="true"');

  // Proposed plan card: long plan collapses behind the Expand toggle, short plan
  // renders fully; both surface the approve action.
  const planCards = html.match(/data-session-ui="proposed-plan-card"/g) ?? [];
  expect(planCards.length).toBe(2);
  expect(html).toContain("Scope retry budgets per attempt chain");
  expect(html).toContain("Expand plan");
  expect(html).toContain("Implement plan");
  expect(html).toContain("Rename the retry flag");

  // Queued pill: honest FIFO copy, Send now only on the head message.
  expect(html).toContain('data-session-ui="queued-message-pill"');
  expect(html).toContain("Queued - sends after the current run");
  expect(html).toContain("Send now");
  expect(html).toContain("Queued #2 - 1 reply ahead");

  // Background status pill: live + monitoring + stopping variants.
  expect(html).toContain('data-session-ui="background-status-pill"');
  expect(html).toContain("Run in progress");
  expect(html).toContain("Monitoring in the background");
  expect(html).toContain("Stopping...");

  // Working indicator + sync pill.
  expect(html).toContain('data-session-ui="working-indicator"');
  expect(html).toContain("Working for");
  expect(html).toContain('data-session-ui="sync-status-pill"');
  expect(html).toContain("Catching up on this thread");
});
