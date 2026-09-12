import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BURN_SCOPE_NOTE, LimitsRow } from "./limits-row";

test("the burn meter says it counts sandbox runs only, with and without usage", () => {
  const empty = renderToStaticMarkup(
    <LimitsRow fleet={{ models: [], totalTokens: 0, totalCost: 0, totalRuns: 0, machine: null }} />,
  );
  expect(empty).toContain("No sandbox runs yet today.");
  expect(empty).toContain(BURN_SCOPE_NOTE);
  expect(BURN_SCOPE_NOTE).toContain("Chat turns are not metered");

  const withUsage = renderToStaticMarkup(
    <LimitsRow
      fleet={{
        models: [{ model: "deepseek/deepseek-v4-flash", runs: 2, completed: 2, avgMs: 40_000, tokens: 12_000, cost: 0.01 }],
        totalTokens: 12_000,
        totalCost: 0.01,
        totalRuns: 2,
        machine: null,
      }}
    />,
  );
  expect(withUsage).toContain(BURN_SCOPE_NOTE);
});
