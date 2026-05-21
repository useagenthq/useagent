import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import * as Tooltip from "@/components/ui/tooltip";
import {
  contextWindowUsedPercentage,
  formatContextWindowTokens,
  T3ContextWindowDetails,
  T3ContextWindowMeter,
} from "./context-window-meter";

test("token formatting follows the upstream compact grammar", () => {
  expect(formatContextWindowTokens(null)).toBe("0");
  expect(formatContextWindowTokens(999)).toBe("999");
  expect(formatContextWindowTokens(1_500)).toBe("1.5k");
  expect(formatContextWindowTokens(10_000)).toBe("10k");
  expect(formatContextWindowTokens(132_000)).toBe("132k");
  expect(formatContextWindowTokens(1_240_000)).toBe("1.2m");
});

test("used percentage clamps to the window and is null without a limit", () => {
  expect(contextWindowUsedPercentage({ usedTokens: 61_400, maxTokens: 200_000 })).toBeCloseTo(30.7);
  expect(contextWindowUsedPercentage({ usedTokens: 500_000, maxTokens: 200_000 })).toBe(100);
  expect(contextWindowUsedPercentage({ usedTokens: 61_400, maxTokens: null })).toBeNull();
});

function render(ui: React.ReactElement): string {
  return renderToStaticMarkup(<Tooltip.Provider>{ui}</Tooltip.Provider>);
}

test("meter ring reports percent used and turns error-red past 90%", () => {
  const steady = render(
    <T3ContextWindowMeter usage={{ usedTokens: 61_400, maxTokens: 200_000 }} />,
  );
  expect(steady).toContain('data-t3-ui="context-window-meter"');
  expect(steady).toContain('aria-label="Context window 31% used"');
  expect(steady).not.toContain("text-error-base");

  const overloaded = render(
    <T3ContextWindowMeter usage={{ usedTokens: 191_000, maxTokens: 200_000 }} />,
  );
  expect(overloaded).toContain('aria-label="Context window 96% used"');
  expect(overloaded).toContain("text-error-base");
});

test("meter without a known limit reports raw tokens instead of a percent", () => {
  const html = render(<T3ContextWindowMeter usage={{ usedTokens: 61_400, maxTokens: null }} />);
  expect(html).toContain('aria-label="Context window 61k tokens used"');
});

test("details panel renders percent, used/max, total processed and compaction note", () => {
  const html = renderToStaticMarkup(
    <T3ContextWindowDetails
      usage={{
        usedTokens: 132_000,
        maxTokens: 200_000,
        totalProcessedTokens: 1_240_000,
        compactsAutomatically: true,
      }}
      providerDisplayName="OpenCode"
    />,
  );
  expect(html).toContain("Context Window");
  expect(html).toContain("66%");
  expect(html).toContain("132k/200k");
  expect(html).toContain('role="progressbar"');
  expect(html).toContain('aria-valuenow="66"');
  expect(html).toContain("Total processed");
  expect(html).toContain("1.2m");
  expect(html).toContain("OpenCode automatically compacts its context when needed.");
});

test("details panel without a limit shows tokens only, no progressbar", () => {
  const html = renderToStaticMarkup(
    <T3ContextWindowDetails usage={{ usedTokens: 61_400, maxTokens: null }} />,
  );
  expect(html).toContain("61k");
  expect(html).not.toContain('role="progressbar"');
});
