import { describe, expect, test } from "bun:test";
import { activeSectionIndex } from "./settings-rail-active";

// The settings page measured on production at 1440x900: section top edges at
// rest inside the shell's <main> scroller (3822px of content, 900px viewport,
// so it bottoms out at scrollTop 2922). Rail order: general, providers,
// integrations, usage, infrastructure, secrets, apikeys, team.
const TOPS_AT_REST = [92, 411, 1550, 1950, 2369, 3043, 3319, 3638] as const;
const VIEWPORT_HEIGHT = 900;
const SCROLL_HEIGHT = 3822;
const MAX_SCROLL_TOP = SCROLL_HEIGHT - VIEWPORT_HEIGHT;

const INFRASTRUCTURE = 4;
const SECRETS = 5;
const TEAM = 7;

const scrolledTo = (scrollTop: number) => ({
  sectionTops: TOPS_AT_REST.map((top) => top - scrollTop),
  viewportHeight: VIEWPORT_HEIGHT,
  scrollTop,
  scrollHeight: SCROLL_HEIGHT,
});

describe("settings rail scroll-spy", () => {
  test("at the bottom of the page the final section wins even when its heading cannot reach the activation line", () => {
    expect(activeSectionIndex(scrolledTo(MAX_SCROLL_TOP))).toBe(TEAM);
  });

  test("a scroller a couple of pixels short of its end still counts as the bottom", () => {
    expect(activeSectionIndex(scrolledTo(MAX_SCROLL_TOP - 2))).toBe(TEAM);
    expect(activeSectionIndex(scrolledTo(MAX_SCROLL_TOP - 3))).toBe(SECRETS);
  });

  test("mid-page a section takes over once its top reaches the upper 30% band", () => {
    const secretsOnTheLine = TOPS_AT_REST[SECRETS] - VIEWPORT_HEIGHT * 0.3;
    expect(activeSectionIndex(scrolledTo(secretsOnTheLine))).toBe(SECRETS);
    expect(activeSectionIndex(scrolledTo(secretsOnTheLine - 1))).toBe(INFRASTRUCTURE);
  });

  test("the first section is active at rest and whenever nothing has crossed the line", () => {
    expect(activeSectionIndex(scrolledTo(0))).toBe(0);
    expect(
      activeSectionIndex({
        sectionTops: [400, 732],
        viewportHeight: VIEWPORT_HEIGHT,
        scrollTop: 0,
        scrollHeight: SCROLL_HEIGHT,
      }),
    ).toBe(0);
  });
});
