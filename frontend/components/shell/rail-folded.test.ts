import { describe, expect, test } from "bun:test";
import { railFolded } from "./rail-folded";

describe("railFolded", () => {
  test("folds the desktop rail only when the sidebar is collapsed", () => {
    expect(railFolded("collapsed", false)).toBe(true);
    expect(railFolded("expanded", false)).toBe(false);
  });

  test("never folds inside the mobile sheet", () => {
    expect(railFolded("collapsed", true)).toBe(false);
    expect(railFolded("expanded", true)).toBe(false);
  });
});
