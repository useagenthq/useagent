import { describe, expect, test } from "bun:test";
import { relativeTime, relativeTimeShort } from "@/utils/format";

/** A fixed clock, so every bucket is a pure function of the age under test. */
const NOW = Date.parse("2026-09-30T12:00:00.000Z");
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * One row per bucket boundary, for both forms at once: `long` is what the compact form is
 * derived from, so a row fails when either drifts. `null` means the date fallback, whose
 * text is the host locale's date.
 *
 * The 90-second and 119-second rows are the point of the table: they pin flooring, so a
 * rounding implementation that reports "2m ago" at 90 seconds cannot pass.
 */
const BUCKETS: Array<[bucket: string, ago: number, long: string | null]> = [
  ["seconds", 20 * SECOND, "just now"],
  ["the last second before a minute", 59 * SECOND, "just now"],
  ["a minute", MINUTE, "1m ago"],
  ["90 seconds", 90 * SECOND, "1m ago"],
  ["119 seconds", 119 * SECOND, "1m ago"],
  ["two minutes", 2 * MINUTE, "2m ago"],
  ["59 minutes", 59 * MINUTE, "59m ago"],
  ["an hour", HOUR, "1h ago"],
  ["23 hours", 23 * HOUR, "23h ago"],
  ["a day", DAY, "1d ago"],
  ["6 days", 6 * DAY, "6d ago"],
  ["a week", 7 * DAY, "1w ago"],
  ["13 days, still the first week bucket", 13 * DAY, "1w ago"],
  ["two weeks", 14 * DAY, "2w ago"],
  ["four weeks", 28 * DAY, "4w ago"],
  ["29 days, one day short of the fallback", 29 * DAY, "4w ago"],
  ["30 days, where the date takes over", 30 * DAY, null],
  ["well past the fallback", 400 * DAY, null],
];

/** The compact form of a row: "now", the label without its suffix, or the date unchanged. */
function compact(row: string | null, date: string): string {
  if (row === null) return date;
  if (row === "just now") return "now";
  return row.slice(0, -4);
}

describe("relativeTime buckets", () => {
  test.each(BUCKETS)("ages %s into the same bucket in both forms", (_bucket, ago, long) => {
    const value = NOW - ago;
    const date = new Date(value).toLocaleDateString();
    const expected = long ?? date;

    expect(relativeTime(value, NOW)).toBe(expected);
    expect(relativeTimeShort(value, NOW)).toBe(compact(long, date));
  });

  test.each(BUCKETS)("reads %s the same from a timestamp and from an ISO string", (_bucket, ago) => {
    const value = NOW - ago;

    expect(relativeTime(new Date(value).toISOString(), NOW)).toBe(relativeTime(value, NOW));
  });
});

describe("relativeTime input handling", () => {
  test("a missing, zero, negative or unparsable value reads as just now", () => {
    expect(relativeTime(null, NOW)).toBe("just now");
    expect(relativeTime(undefined, NOW)).toBe("just now");
    expect(relativeTime(0, NOW)).toBe("just now");
    expect(relativeTime(-1, NOW)).toBe("just now");
    expect(relativeTime("not a date", NOW)).toBe("just now");
    expect(relativeTimeShort("not a date", NOW)).toBe("now");
  });

  test("a value in the future never reads as a negative age", () => {
    expect(relativeTime(NOW + HOUR, NOW)).toBe("just now");
    expect(relativeTimeShort(NOW + HOUR, NOW)).toBe("now");
  });

  test("the fallback is a date, so an old value never counts up in weeks forever", () => {
    const old = relativeTime(NOW - 400 * DAY, NOW);

    expect(old).not.toMatch(/w ago$/);
    expect(old).toBe(new Date(NOW - 400 * DAY).toLocaleDateString());
  });
});
