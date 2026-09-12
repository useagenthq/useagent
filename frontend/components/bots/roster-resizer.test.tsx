import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ROSTER_DEFAULT,
  ROSTER_MAX,
  ROSTER_MIN,
  RosterResizer,
  rosterWidthFor,
  rosterWidthForKey,
  rosterWidthFromPointer,
} from "./roster-resizer";

const read = (file: string) => readFileSync(join(import.meta.dir, file), "utf8");

describe("roster width", () => {
  test("measures from the container's LEFT edge, since the roster is the left pane", () => {
    expect(rosterWidthFromPointer({ containerLeft: 100, containerWidth: 1400, pointerX: 460 })).toBe(360);
  });

  test("clamps to the range and leaves the thread its floor", () => {
    expect(rosterWidthFor({ wanted: 10, containerWidth: 1400 })).toBe(ROSTER_MIN);
    expect(rosterWidthFor({ wanted: 900, containerWidth: 1400 })).toBe(ROSTER_MAX);
    // 900px split: the thread keeps 480, so the roster tops out at 420.
    expect(rosterWidthFor({ wanted: 900, containerWidth: 900 })).toBe(420);
    // Too narrow to honor both: the roster minimum wins.
    expect(rosterWidthFor({ wanted: 400, containerWidth: 600 })).toBe(ROSTER_MIN);
  });

  test("arrow keys move 16px the natural way for a left pane; Home and End hit the ends", () => {
    expect(rosterWidthForKey({ key: "ArrowRight", current: 320, containerWidth: 1400 })).toBe(336);
    expect(rosterWidthForKey({ key: "ArrowLeft", current: 320, containerWidth: 1400 })).toBe(304);
    expect(rosterWidthForKey({ key: "Home", current: 320, containerWidth: 1400 })).toBe(ROSTER_MIN);
    expect(rosterWidthForKey({ key: "End", current: 320, containerWidth: 1400 })).toBe(ROSTER_MAX);
    expect(rosterWidthForKey({ key: "Enter", current: 320, containerWidth: 1400 })).toBeNull();
  });

  test("the default matches the roster's CSS default", () => {
    expect(ROSTER_DEFAULT).toBe(320);
    expect(read("./bots-roster.tsx")).toContain("md:w-[var(--roster-w,20rem)]");
  });
});

describe("RosterResizer", () => {
  test("is a keyboard-reachable vertical separator with the rail grip's grammar", () => {
    const html = renderToStaticMarkup(
      <RosterResizer value={320} onMove={() => {}} onCommit={() => {}} onKeyDown={() => {}} onReset={() => {}} />,
    );
    expect(html).toContain('data-testid="roster-resize-grip"');
    expect(html).toContain('aria-orientation="vertical"');
    expect(html).toContain('aria-label="Resize the bots list; double-click to reset"');
    expect(html).toContain(`aria-valuemin="${ROSTER_MIN}"`);
    expect(html).toContain(`aria-valuemax="${ROSTER_MAX}"`);
    expect(html).toContain('aria-valuenow="320"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain("cursor-col-resize");
    // Phone shows one pane at a time, so the grip only exists from md up.
    expect(html).toContain("hidden");
    expect(html).toContain("md:block");
  });

  test("the workspace mounts the grip between the roster and the thread", () => {
    const workspace = read("./bots-workspace.tsx");
    const roster = workspace.indexOf("<BotsRoster");
    const grip = workspace.indexOf("<RosterResizer");
    const thread = workspace.indexOf("<BotThreadPane");
    expect(roster).toBeGreaterThan(-1);
    expect(grip).toBeGreaterThan(roster);
    expect(thread).toBeGreaterThan(grip);
    expect(workspace).toContain('"--roster-w"');
  });
});
