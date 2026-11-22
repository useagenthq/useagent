import { describe, expect, test } from "bun:test";
import { decodeFiringPage, firingPagePath, withOlderPage, withRefreshedPage } from "./firing-history";

const row = (id: string) => ({ id, fired_at: "2026-03-01T12:00:00.000Z" });
const page = (ids: string[], nextCursor: string | null) => ({ firings: ids.map(row), nextCursor });
const ids = (value: { firings: { id: string }[] }) => value.firings.map((firing) => firing.id);

describe("firing history pages", () => {
  test("reads the cursor next to the firings, and an older backend's bare list as the only page", () => {
    expect(decodeFiringPage({ firings: [row("a")], has_more: true, next_cursor: "c1" })).toEqual(page(["a"], "c1"));
    expect(decodeFiringPage({ firings: [row("a")] })).toEqual(page(["a"], null));
    expect(decodeFiringPage({ firings: [row("a")], next_cursor: "" })).toEqual(page(["a"], null));
    expect(decodeFiringPage([row("a")])).toEqual(page(["a"], null));
    expect(decodeFiringPage(null)).toEqual(page([], null));
  });

  test("puts the cursor in the query only when asking for older firings", () => {
    expect(firingPagePath("/api/automations/a1/history", null)).toBe("/api/automations/a1/history");
    expect(firingPagePath("/api/automations/a1/history", "x/y=")).toBe("/api/automations/a1/history?cursor=x%2Fy%3D");
  });

  test("an older page goes after the loaded rows without repeating one, and carries its own cursor", () => {
    const merged = withOlderPage(page(["d", "c"], "c1"), page(["c", "b", "a"], null));
    expect(ids(merged)).toEqual(["d", "c", "b", "a"]);
    expect(merged.nextCursor).toBeNull();
  });

  test("a refresh replaces the list until older rows are loaded, then goes in front of them", () => {
    expect(withRefreshedPage(null, page(["b", "a"], "c1"), false)).toEqual(page(["b", "a"], "c1"));
    expect(withRefreshedPage(page(["b", "a"], "c1"), page(["c", "b"], "c2"), false)).toEqual(page(["c", "b"], "c2"));

    const loaded = page(["d", "c", "b", "a"], "tail");
    const refreshed = withRefreshedPage(loaded, page(["e", "d"], "c-new"), true);
    expect(ids(refreshed)).toEqual(["e", "d", "c", "b", "a"]);
    // The older rows' cursor still asks for what follows them.
    expect(refreshed.nextCursor).toBe("tail");
  });
});
