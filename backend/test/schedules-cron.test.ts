import { describe, expect, test } from "bun:test";
import { cronMatches, isValidCron } from "../src/schedules/cron";

/** Build a local-time Date at the given fields (month is 1-based here). */
function at(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

describe("cron matcher", () => {
  test("every-minute wildcard matches any time", () => {
    expect(cronMatches("* * * * *", at(2026, 8, 5, 13, 37))).toBe(true);
    expect(cronMatches("* * * * *", at(2026, 1, 1, 0, 0))).toBe(true);
  });

  test("exact minute+hour", () => {
    // 2026-08-05 is a Wednesday (dow 3).
    expect(cronMatches("30 2 * * *", at(2026, 8, 5, 2, 30))).toBe(true);
    expect(cronMatches("30 2 * * *", at(2026, 8, 5, 2, 31))).toBe(false);
    expect(cronMatches("30 2 * * *", at(2026, 8, 5, 3, 30))).toBe(false);
  });

  test("*/N step on minutes", () => {
    const expr = "*/15 * * * *";
    expect(cronMatches(expr, at(2026, 8, 5, 9, 0))).toBe(true);
    expect(cronMatches(expr, at(2026, 8, 5, 9, 15))).toBe(true);
    expect(cronMatches(expr, at(2026, 8, 5, 9, 30))).toBe(true);
    expect(cronMatches(expr, at(2026, 8, 5, 9, 45))).toBe(true);
    expect(cronMatches(expr, at(2026, 8, 5, 9, 7))).toBe(false);
    expect(cronMatches(expr, at(2026, 8, 5, 9, 46))).toBe(false);
  });

  test("bare-value step (5/10) counts from the start value", () => {
    const expr = "5/10 * * * *";
    for (const m of [5, 15, 25, 35, 45, 55]) {
      expect(cronMatches(expr, at(2026, 8, 5, 9, m))).toBe(true);
    }
    expect(cronMatches(expr, at(2026, 8, 5, 9, 0))).toBe(false);
    expect(cronMatches(expr, at(2026, 8, 5, 9, 10))).toBe(false);
  });

  test("ranges on hours", () => {
    const expr = "0 9-17 * * *";
    expect(cronMatches(expr, at(2026, 8, 5, 9, 0))).toBe(true);
    expect(cronMatches(expr, at(2026, 8, 5, 17, 0))).toBe(true);
    expect(cronMatches(expr, at(2026, 8, 5, 8, 0))).toBe(false);
    expect(cronMatches(expr, at(2026, 8, 5, 18, 0))).toBe(false);
  });

  test("range with step (0-30/10)", () => {
    const expr = "0-30/10 * * * *";
    for (const m of [0, 10, 20, 30]) {
      expect(cronMatches(expr, at(2026, 8, 5, 9, m))).toBe(true);
    }
    expect(cronMatches(expr, at(2026, 8, 5, 9, 40))).toBe(false);
    expect(cronMatches(expr, at(2026, 8, 5, 9, 5))).toBe(false);
  });

  test("comma lists", () => {
    const expr = "0,30 8,12,18 * * *";
    expect(cronMatches(expr, at(2026, 8, 5, 8, 0))).toBe(true);
    expect(cronMatches(expr, at(2026, 8, 5, 12, 30))).toBe(true);
    expect(cronMatches(expr, at(2026, 8, 5, 18, 0))).toBe(true);
    expect(cronMatches(expr, at(2026, 8, 5, 8, 15))).toBe(false);
    expect(cronMatches(expr, at(2026, 8, 5, 9, 0))).toBe(false);
  });

  test("mixed list of ranges and steps", () => {
    const expr = "0 0 * * 1-5"; // weekdays midnight
    // 2026-08-05 Wed, 2026-08-08 Sat, 2026-08-09 Sun
    expect(cronMatches(expr, at(2026, 8, 5, 0, 0))).toBe(true); // Wed
    expect(cronMatches(expr, at(2026, 8, 8, 0, 0))).toBe(false); // Sat
    expect(cronMatches(expr, at(2026, 8, 9, 0, 0))).toBe(false); // Sun
  });

  test("day-of-week: 0 and 7 both mean Sunday", () => {
    // 2026-08-09 is a Sunday.
    expect(cronMatches("0 12 * * 0", at(2026, 8, 9, 12, 0))).toBe(true);
    expect(cronMatches("0 12 * * 7", at(2026, 8, 9, 12, 0))).toBe(true);
    expect(cronMatches("0 12 * * 0", at(2026, 8, 5, 12, 0))).toBe(false); // Wed
  });

  test("day-of-month matching", () => {
    const expr = "0 0 1 * *"; // first of the month
    expect(cronMatches(expr, at(2026, 8, 1, 0, 0))).toBe(true);
    expect(cronMatches(expr, at(2026, 8, 2, 0, 0))).toBe(false);
  });

  test("month field", () => {
    const expr = "0 0 1 1 *"; // Jan 1
    expect(cronMatches(expr, at(2026, 1, 1, 0, 0))).toBe(true);
    expect(cronMatches(expr, at(2026, 8, 1, 0, 0))).toBe(false);
  });

  test("dom+dow OR semantics (both restricted → either matches)", () => {
    // "1st of month OR any Monday". 2026-08-01 is a Saturday (dom match only);
    // 2026-08-03 is a Monday (dow match only); 2026-08-04 is a Tuesday (neither).
    const expr = "0 0 1 * 1";
    expect(cronMatches(expr, at(2026, 8, 1, 0, 0))).toBe(true); // dom hit
    expect(cronMatches(expr, at(2026, 8, 3, 0, 0))).toBe(true); // dow hit (Mon)
    expect(cronMatches(expr, at(2026, 8, 4, 0, 0))).toBe(false); // neither
  });

  test("dom restricted, dow wildcard → AND (dow never restricts)", () => {
    const expr = "0 0 15 * *";
    expect(cronMatches(expr, at(2026, 8, 15, 0, 0))).toBe(true);
    expect(cronMatches(expr, at(2026, 8, 16, 0, 0))).toBe(false);
  });

  test("isValidCron accepts good expressions", () => {
    for (const e of [
      "* * * * *",
      "*/5 * * * *",
      "0 9-17 * * 1-5",
      "0,30 0 1 1 0",
      "5/10 0-12/2 1-28 */3 0-6",
    ]) {
      expect(isValidCron(e)).toBe(true);
    }
  });

  test("isValidCron rejects malformed expressions", () => {
    for (const e of [
      "",
      "* * * *", // 4 fields
      "* * * * * *", // 6 fields
      "60 * * * *", // minute out of range
      "* 24 * * *", // hour out of range
      "* * 0 * *", // dom below 1
      "* * 32 * *", // dom above 31
      "* * * 13 *", // month above 12
      "* * * * 8", // dow above 7
      "*/0 * * * *", // zero step
      "5-1 * * * *", // reversed range
      "a * * * *", // non-numeric
    ]) {
      expect(isValidCron(e)).toBe(false);
      expect(cronMatches(e, at(2026, 8, 5, 0, 0))).toBe(false);
    }
  });
});
