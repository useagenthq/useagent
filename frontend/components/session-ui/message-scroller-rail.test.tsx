import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  deriveScrollerTicks,
  MessageScrollerRail,
  MIN_TURNS_FOR_SCROLLER,
  pickActiveTurnIndex,
  scrollerTickSnippet,
  shouldShowScrollerRail,
} from "./message-scroller-rail";

const turnsOf = (...prompts: string[]) =>
  prompts.map((prompt, i) => ({ run: { id: `run-${i}`, prompt } }));

describe("tick derivation", () => {
  test("one tick per turn, id-keyed, with a cleaned prompt snippet", () => {
    const ticks = deriveScrollerTicks(turnsOf("Fix the retry budget", "Now add a test"));
    expect(ticks).toEqual([
      { id: "run-0", snippet: "Fix the retry budget" },
      { id: "run-1", snippet: "Now add a test" },
    ]);
  });

  test("snippet caps at ~40 chars with an ellipsis and collapses whitespace", () => {
    const long = "Refactor   the\nprovider gateway retry loop to scope the budget per attempt";
    const snip = scrollerTickSnippet(long);
    expect(snip.endsWith("…")).toBe(true);
    // 40 content chars max, plus the single ellipsis glyph.
    expect([...snip].length).toBeLessThanOrEqual(41);
    expect(snip).not.toContain("\n");
    expect(snip.startsWith("Refactor the provider")).toBe(true);
  });

  test("short prompts pass through untruncated (no ellipsis)", () => {
    expect(scrollerTickSnippet("  hi there  ")).toBe("hi there");
  });

  test("cleanPrompt wrapper is stripped from the snippet", () => {
    const wrapped = "Follow-up to a previous task. Context here. New request: ship the rail";
    expect(scrollerTickSnippet(wrapped)).toBe("ship the rail");
  });
});

describe("visibility gate", () => {
  test(`hidden under ${MIN_TURNS_FOR_SCROLLER} turns, shown at or above`, () => {
    expect(shouldShowScrollerRail(0)).toBe(false);
    expect(shouldShowScrollerRail(MIN_TURNS_FOR_SCROLLER - 1)).toBe(false);
    expect(shouldShowScrollerRail(MIN_TURNS_FOR_SCROLLER)).toBe(true);
    expect(shouldShowScrollerRail(12)).toBe(true);
  });
});

describe("in-view selection", () => {
  test("topmost intersecting turn is active", () => {
    expect(pickActiveTurnIndex(new Set([2, 5, 3]), 0)).toBe(2);
    expect(pickActiveTurnIndex(new Set([7]), 0)).toBe(7);
  });

  test("falls back to the last-known index when nothing intersects", () => {
    expect(pickActiveTurnIndex(new Set(), 4)).toBe(4);
  });
});

describe("render gating", () => {
  test("renders nothing below the turn threshold", () => {
    const html = renderToStaticMarkup(
      <MessageScrollerRail turns={turnsOf("a", "b", "c")} scrollRef={{ current: null }} />,
    );
    expect(html).toBe("");
  });

  test("renders one titled tick button per turn at/above the threshold", () => {
    const html = renderToStaticMarkup(
      <MessageScrollerRail
        turns={turnsOf("first turn", "second turn", "third turn", "fourth turn")}
        scrollRef={{ current: null }}
      />,
    );
    expect(html).toContain('data-session-ui="message-scroller-rail"');
    // Four ticks, each a titled button.
    expect(html.match(/<button/g)?.length).toBe(4);
    expect(html).toContain('title="first turn"');
    expect(html).toContain('aria-label="Jump to turn 4: fourth turn"');
    // First tick is active on first paint (activeIndex defaults to 0).
    expect(html).toContain('aria-current="true"');
  });
});
