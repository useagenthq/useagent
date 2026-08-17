import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  buildCollapsedProposedPlanPreviewMarkdown,
  buildPlanImplementationPrompt,
  proposedPlanTitle,
  stripDisplayedPlanMarkdown,
  ProposedPlanCard,
} from "./proposed-plan-card";

const SHORT_PLAN = [
  "# Scope retry budgets",
  "",
  "1. Add budgetFor to retry.ts",
  "2. Re-run the focused suite",
].join("\n");

const LONG_PLAN = [
  "# Scope retry budgets per attempt chain",
  "",
  "## Summary",
  "",
  "Hedged requests share one retry budget, so a slow primary starves its hedge.",
  "",
  "## Steps",
  ...Array.from({ length: 20 }, (_, i) => `${i + 1}. Step ${i + 1} of the retry budget work`),
  "",
  "## Verification",
  "",
  "Run the provider-gateway suite and confirm zero shared-budget exhaustion.",
].join("\n");

test("proposedPlanTitle reads the first markdown heading", () => {
  expect(proposedPlanTitle(LONG_PLAN)).toBe("Scope retry budgets per attempt chain");
  expect(proposedPlanTitle("just prose, no heading")).toBeNull();
});

test("stripDisplayedPlanMarkdown drops the title and a redundant Summary heading", () => {
  const stripped = stripDisplayedPlanMarkdown(LONG_PLAN);
  expect(stripped.startsWith("Hedged requests share one retry budget")).toBe(true);
  expect(stripped).not.toContain("# Scope retry budgets per attempt chain");
  // A body without a leading heading passes through untouched.
  expect(stripDisplayedPlanMarkdown("plain body")).toBe("plain body");
});

test("buildCollapsedProposedPlanPreviewMarkdown caps visible lines and appends an ellipsis", () => {
  const preview = buildCollapsedProposedPlanPreviewMarkdown(LONG_PLAN, { maxLines: 4 });
  const visible = preview.split("\n").filter((line) => line.trim().length > 0);
  expect(visible.length).toBe(5); // 4 content lines + the "..." marker
  expect(preview.endsWith("...")).toBe(true);
  expect(preview).not.toContain("Verification");
});

test("buildCollapsedProposedPlanPreviewMarkdown falls back to the title for empty bodies", () => {
  expect(buildCollapsedProposedPlanPreviewMarkdown("# Only a title")).toBe("Only a title");
});

test("buildPlanImplementationPrompt wraps the plan in the upstream approval grammar", () => {
  expect(buildPlanImplementationPrompt(" # Plan \n")).toBe("PLEASE IMPLEMENT THIS PLAN:\n# Plan");
});

test("short plan renders fully with no expand toggle and no approve action", () => {
  const html = renderToStaticMarkup(<ProposedPlanCard planMarkdown={SHORT_PLAN} />);
  expect(html).toContain('data-session-ui="proposed-plan-card"');
  expect(html).toContain("Scope retry budgets");
  expect(html).toContain("Re-run the focused suite");
  expect(html).not.toContain("Expand plan");
  expect(html).not.toContain("Implement plan");
});

test("long plan collapses to the preview behind the toggle", () => {
  const html = renderToStaticMarkup(<ProposedPlanCard planMarkdown={LONG_PLAN} />);
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain("Expand plan");
  expect(html).toContain("Hedged requests share one retry budget");
  expect(html).not.toContain("Verification");
});

test("defaultExpanded shows the full plan and the collapse toggle", () => {
  const html = renderToStaticMarkup(
    <ProposedPlanCard planMarkdown={LONG_PLAN} defaultExpanded />,
  );
  expect(html).toContain('aria-expanded="true"');
  expect(html).toContain("Collapse plan");
  expect(html).toContain("Verification");
});

test("onImplement surfaces the approve action", () => {
  const html = renderToStaticMarkup(
    <ProposedPlanCard planMarkdown={SHORT_PLAN} onImplement={() => {}} />,
  );
  expect(html).toContain("Implement plan");
});

test("renders nothing for an empty plan", () => {
  expect(renderToStaticMarkup(<ProposedPlanCard planMarkdown={"  \n "} />)).toBe("");
});
