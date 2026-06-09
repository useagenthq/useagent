import { describe, expect, test } from "bun:test";
import {
  RAIL_DEFAULT,
  RAIL_MAX,
  RAIL_MIN,
  railWidthForKey,
  railWidthFromPointer,
} from "./rail-resizer";

describe("rail resizing", () => {
  test("maps pointer position into the bounded side-panel width", () => {
    expect(
      railWidthFromPointer({ containerRight: 1_600, containerWidth: 1_200, pointerX: 1_088 }),
    ).toBe(500);
    expect(
      railWidthFromPointer({ containerRight: 1_600, containerWidth: 1_200, pointerX: 1_500 }),
    ).toBe(RAIL_MIN);
    expect(
      railWidthFromPointer({ containerRight: 1_600, containerWidth: 1_200, pointerX: 100 }),
    ).toBe(720);
    expect(RAIL_MAX).toBe(960);
    expect(RAIL_DEFAULT).toBe(360);
    // The floor that keeps the terminal pane at ~40+ columns.
    expect(RAIL_MIN).toBe(360);
  });

  test("supports accessible keyboard resizing without interpreting other keys", () => {
    expect(railWidthForKey({ key: "ArrowLeft", current: 480, maximum: 720 })).toBe(496);
    expect(railWidthForKey({ key: "ArrowRight", current: 480, maximum: 720 })).toBe(464);
    expect(railWidthForKey({ key: "Home", current: 480, maximum: 720 })).toBe(RAIL_MIN);
    expect(railWidthForKey({ key: "End", current: 480, maximum: 720 })).toBe(720);
    expect(railWidthForKey({ key: "Enter", current: 480, maximum: 720 })).toBeNull();
  });
});
