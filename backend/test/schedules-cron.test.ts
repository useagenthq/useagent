import { describe, expect, test } from "bun:test";
import { cronMatches, isOccurrence, isValidCron, nextOccurrence } from "../src/schedules/cron";

/** The UTC instant at the given wall-clock fields (month is 1-based here). */
function at(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, minute));
}

/** The field matcher, read in UTC. */
const matches = (expr: string, date: Date) => cronMatches(expr, date, "UTC");

describe("cron matcher", () => {
  test("every-minute wildcard matches any time", () => {
    expect(matches("* * * * *", at(2026, 8, 5, 13, 37))).toBe(true);
    expect(matches("* * * * *", at(2026, 1, 1, 0, 0))).toBe(true);
  });

  test("exact minute+hour", () => {
    // 2026-08-05 is a Wednesday (dow 3).
    expect(matches("30 2 * * *", at(2026, 8, 5, 2, 30))).toBe(true);
    expect(matches("30 2 * * *", at(2026, 8, 5, 2, 31))).toBe(false);
    expect(matches("30 2 * * *", at(2026, 8, 5, 3, 30))).toBe(false);
  });

  test("*/N step on minutes", () => {
    const expr = "*/15 * * * *";
    expect(matches(expr, at(2026, 8, 5, 9, 0))).toBe(true);
    expect(matches(expr, at(2026, 8, 5, 9, 15))).toBe(true);
    expect(matches(expr, at(2026, 8, 5, 9, 30))).toBe(true);
    expect(matches(expr, at(2026, 8, 5, 9, 45))).toBe(true);
    expect(matches(expr, at(2026, 8, 5, 9, 7))).toBe(false);
    expect(matches(expr, at(2026, 8, 5, 9, 46))).toBe(false);
  });

  test("bare-value step (5/10) counts from the start value", () => {
    const expr = "5/10 * * * *";
    for (const m of [5, 15, 25, 35, 45, 55]) {
      expect(matches(expr, at(2026, 8, 5, 9, m))).toBe(true);
    }
    expect(matches(expr, at(2026, 8, 5, 9, 0))).toBe(false);
    expect(matches(expr, at(2026, 8, 5, 9, 10))).toBe(false);
  });

  test("ranges on hours", () => {
    const expr = "0 9-17 * * *";
    expect(matches(expr, at(2026, 8, 5, 9, 0))).toBe(true);
    expect(matches(expr, at(2026, 8, 5, 17, 0))).toBe(true);
    expect(matches(expr, at(2026, 8, 5, 8, 0))).toBe(false);
    expect(matches(expr, at(2026, 8, 5, 18, 0))).toBe(false);
  });

  test("range with step (0-30/10)", () => {
    const expr = "0-30/10 * * * *";
    for (const m of [0, 10, 20, 30]) {
      expect(matches(expr, at(2026, 8, 5, 9, m))).toBe(true);
    }
    expect(matches(expr, at(2026, 8, 5, 9, 40))).toBe(false);
    expect(matches(expr, at(2026, 8, 5, 9, 5))).toBe(false);
  });

  test("comma lists", () => {
    const expr = "0,30 8,12,18 * * *";
    expect(matches(expr, at(2026, 8, 5, 8, 0))).toBe(true);
    expect(matches(expr, at(2026, 8, 5, 12, 30))).toBe(true);
    expect(matches(expr, at(2026, 8, 5, 18, 0))).toBe(true);
    expect(matches(expr, at(2026, 8, 5, 8, 15))).toBe(false);
    expect(matches(expr, at(2026, 8, 5, 9, 0))).toBe(false);
  });

  test("mixed list of ranges and steps", () => {
    const expr = "0 0 * * 1-5"; // weekdays midnight
    // 2026-08-05 Wed, 2026-08-08 Sat, 2026-08-09 Sun
    expect(matches(expr, at(2026, 8, 5, 0, 0))).toBe(true); // Wed
    expect(matches(expr, at(2026, 8, 8, 0, 0))).toBe(false); // Sat
    expect(matches(expr, at(2026, 8, 9, 0, 0))).toBe(false); // Sun
  });

  test("day-of-week: 0 and 7 both mean Sunday", () => {
    // 2026-08-09 is a Sunday.
    expect(matches("0 12 * * 0", at(2026, 8, 9, 12, 0))).toBe(true);
    expect(matches("0 12 * * 7", at(2026, 8, 9, 12, 0))).toBe(true);
    expect(matches("0 12 * * 0", at(2026, 8, 5, 12, 0))).toBe(false); // Wed
  });

  test("day-of-month matching", () => {
    const expr = "0 0 1 * *"; // first of the month
    expect(matches(expr, at(2026, 8, 1, 0, 0))).toBe(true);
    expect(matches(expr, at(2026, 8, 2, 0, 0))).toBe(false);
  });

  test("month field", () => {
    const expr = "0 0 1 1 *"; // Jan 1
    expect(matches(expr, at(2026, 1, 1, 0, 0))).toBe(true);
    expect(matches(expr, at(2026, 8, 1, 0, 0))).toBe(false);
  });

  test("dom+dow OR semantics (both restricted → either matches)", () => {
    // "1st of month OR any Monday". 2026-08-01 is a Saturday (dom match only);
    // 2026-08-03 is a Monday (dow match only); 2026-08-04 is a Tuesday (neither).
    const expr = "0 0 1 * 1";
    expect(matches(expr, at(2026, 8, 1, 0, 0))).toBe(true); // dom hit
    expect(matches(expr, at(2026, 8, 3, 0, 0))).toBe(true); // dow hit (Mon)
    expect(matches(expr, at(2026, 8, 4, 0, 0))).toBe(false); // neither
  });

  test("dom restricted, dow wildcard → AND (dow never restricts)", () => {
    const expr = "0 0 15 * *";
    expect(matches(expr, at(2026, 8, 15, 0, 0))).toBe(true);
    expect(matches(expr, at(2026, 8, 16, 0, 0))).toBe(false);
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
      expect(matches(e, at(2026, 8, 5, 0, 0))).toBe(false);
    }
  });
});

/** The next occurrence at or after `from`, as an ISO string (null for none). */
function next(expr: string, timeZone: string, from: string): string | null {
  return nextOccurrence(expr, timeZone, new Date(from))?.toISOString() ?? null;
}

/** Every occurrence in [from, to), stepping through nextOccurrence. */
function occurrences(expr: string, timeZone: string, from: string, to: string): string[] {
  const out: string[] = [];
  const end = new Date(to).getTime();
  for (let at = nextOccurrence(expr, timeZone, new Date(from)); at && at.getTime() < end;
    at = nextOccurrence(expr, timeZone, new Date(at.getTime() + 60_000))) {
    out.push(at.toISOString());
  }
  return out;
}

describe("occurrences (nextOccurrence)", () => {
  test("from rounds up to a whole minute and is inclusive", () => {
    expect(next("* * * * *", "UTC", "2026-10-16T12:00:00.000Z")).toBe("2026-10-16T12:00:00.000Z");
    expect(next("* * * * *", "UTC", "2026-10-16T12:00:00.001Z")).toBe("2026-10-16T12:01:00.000Z");
    expect(next("0 0 * * *", "UTC", "2026-10-16T23:30:00.000Z")).toBe("2026-10-17T00:00:00.000Z");
    expect(next("0 9 * * *", "Asia/Kolkata", "2026-10-16T04:00:00.000Z")).toBe("2026-10-17T03:30:00.000Z");
  });

  test("an expression that names no date has none; a rare one is still found", () => {
    expect(next("0 0 31 2 *", "UTC", "2026-10-16T00:00:00.000Z")).toBeNull();
    expect(next("not cron", "UTC", "2026-10-16T00:00:00.000Z")).toBeNull();
    expect(next("0 0 29 2 *", "UTC", "2026-10-16T00:00:00.000Z")).toBe("2028-02-29T00:00:00.000Z");
    expect(next("0 0 29 2 *", "UTC", "2096-03-01T00:00:00.000Z")).toBe("2104-02-29T00:00:00.000Z");
  });

  // The cases where a second copy of the schedule math could disagree with the
  // scheduler; here one function answers for the scheduler and the API alike.
  test("fall-back: a fixed time repeated by the change fires once, at its first reading", () => {
    // New York 2026-11-01: 01:30 EDT is 05:30Z, 01:30 EST is 06:30Z.
    expect(next("30 1 * * *", "America/New_York", "2026-11-01T05:00:00.000Z")).toBe("2026-11-01T05:30:00.000Z");
    expect(next("30 1 * * *", "America/New_York", "2026-11-01T05:45:00.000Z")).toBe("2026-11-02T06:30:00.000Z");
    // Berlin 2026-10-25: 02:00-02:59 CEST is 00:00-00:59Z, CET 01:00-01:59Z.
    expect(occurrences("0,45 2 * * *", "Europe/Berlin", "2026-10-24T12:00:00.000Z", "2026-10-26T12:00:00.000Z")).toEqual([
      "2026-10-25T00:00:00.000Z",
      "2026-10-25T00:45:00.000Z",
      "2026-10-26T01:00:00.000Z",
      "2026-10-26T01:45:00.000Z",
    ]);
    // Lord Howe moves 30 minutes: 01:45 LHDT is 14:45Z, 01:45 LHST 15:15Z.
    expect(next("45 1 * * *", "Australia/Lord_Howe", "2026-04-04T14:00:00.000Z")).toBe("2026-04-04T14:45:00.000Z");
    expect(next("45 1 * * *", "Australia/Lord_Howe", "2026-04-04T14:46:00.000Z")).toBe("2026-04-05T15:15:00.000Z");
  });

  test("fall-back: a periodic expression keeps real time through the repeated hour", () => {
    expect(occurrences("*/30 * * * *", "America/New_York", "2026-11-01T05:00:00.000Z", "2026-11-01T07:01:00.000Z")).toEqual([
      "2026-11-01T05:00:00.000Z", // 01:00 EDT
      "2026-11-01T05:30:00.000Z", // 01:30 EDT
      "2026-11-01T06:00:00.000Z", // 01:00 EST
      "2026-11-01T06:30:00.000Z", // 01:30 EST
      "2026-11-01T07:00:00.000Z", // 02:00 EST
    ]);
  });

  test("spring-forward: a fixed time the change skips fires at the first minute after the gap", () => {
    // New York 2026-03-08: 02:00-02:59 does not exist; 03:00 EDT is 07:00Z.
    expect(occurrences("30 2 * * *", "America/New_York", "2026-03-07T00:00:00.000Z", "2026-03-10T00:00:00.000Z")).toEqual([
      "2026-03-07T07:30:00.000Z",
      "2026-03-08T07:00:00.000Z",
      "2026-03-09T06:30:00.000Z",
    ]);
    // A skipped time and a real one landing on the same minute are one occurrence.
    expect(occurrences("0 2,3 * * *", "America/New_York", "2026-03-08T00:00:00.000Z", "2026-03-08T12:00:00.000Z")).toEqual([
      "2026-03-08T07:00:00.000Z",
    ]);
    // Lord Howe 2026-10-04: 02:00 LHST (15:30Z) becomes 02:30 LHDT.
    expect(next("15 2 * * *", "Australia/Lord_Howe", "2026-10-03T14:00:00.000Z")).toBe("2026-10-03T15:30:00.000Z");
  });

  test("spring-forward: a periodic expression does not stand in for skipped minutes", () => {
    expect(occurrences("*/30 * * * *", "America/New_York", "2026-03-08T06:00:00.000Z", "2026-03-08T07:31:00.000Z")).toEqual([
      "2026-03-08T06:00:00.000Z", // 01:00 EST
      "2026-03-08T06:30:00.000Z", // 01:30 EST
      "2026-03-08T07:00:00.000Z", // 03:00 EDT
      "2026-03-08T07:30:00.000Z", // 03:30 EDT
    ]);
  });

  test("occurrences are exactly the minutes the field matcher accepts, apart from a fixed time's DST repeats and gaps", () => {
    const expressions = [
      "* * * * *",
      "*/7 * * * *",
      "0 * * * *",
      "30 9 * * 1-5",
      "15 3 1,15 * *",
      "0 0 * * 0",
      "5/10 0-12/2 1-28 */3 0-6",
      "0 12 1 * 1",
      "* 2 * * *",
      "0 1-3 * * *",
    ];
    const zones = ["UTC", "America/New_York", "Europe/Berlin", "Asia/Kolkata", "Asia/Kathmandu", "Australia/Lord_Howe"];
    // Two windows, each across a change in the northern or the southern zones.
    const windows = [
      [Date.UTC(2026, 2, 6), Date.UTC(2026, 2, 10)],
      [Date.UTC(2026, 9, 2), Date.UTC(2026, 9, 6)],
      [Date.UTC(2026, 9, 24), Date.UTC(2026, 10, 3)],
    ] as const;
    for (const zone of zones) {
      for (const expr of expressions) {
        const fixedTime = !/^\*/.test(expr.split(" ")[0]!) && !/^\*/.test(expr.split(" ")[1]!);
        for (const [start, end] of windows) {
          let due = nextOccurrence(expr, zone, new Date(start))?.getTime();
          for (let at = start; at < end; at += 60_000) {
            const isOccurrence = at === due;
            if (isOccurrence) due = nextOccurrence(expr, zone, new Date(at + 60_000))?.getTime();
            const matches = cronMatches(expr, new Date(at), zone);
            if (isOccurrence === matches) continue;
            // Only a fixed time across a change may differ, and only as the rule says.
            expect(fixedTime).toBe(true);
            const offsetNow = Math.round((Date.parse(new Date(at).toLocaleString("en-US", { timeZone: zone })) - Date.parse(new Date(at).toLocaleString("en-US", { timeZone: "UTC" }))) / 60_000);
            const offsetBefore = Math.round((Date.parse(new Date(at - 3 * 3_600_000).toLocaleString("en-US", { timeZone: zone })) - Date.parse(new Date(at - 3 * 3_600_000).toLocaleString("en-US", { timeZone: "UTC" }))) / 60_000);
            expect(offsetNow).not.toBe(offsetBefore);
          }
        }
      }
    }
  });
});

describe("rare expressions", () => {
  test("days that cannot match are passed without changing what comes next", () => {
    // The first Sunday of November 2026 is the New York fall-back: 01:30 EDT.
    expect(next("30 1 * 11 0", "America/New_York", "2026-10-18T00:00:00.000Z")).toBe("2026-11-01T05:30:00.000Z");
    // The first Sunday of March 2027 is still standard time.
    expect(next("15 2 * 3 0", "America/New_York", "2026-10-18T00:00:00.000Z")).toBe("2027-03-07T07:15:00.000Z");
    // 2027-03-14 02:15 is skipped by the spring-forward: the first minute after it.
    expect(next("15 2 14 3 *", "America/New_York", "2026-10-18T00:00:00.000Z")).toBe("2027-03-14T07:00:00.000Z");
    // Lord Howe's half-hour fall-back on 2027-04-04: 01:45 LHDT, the first reading.
    expect(next("45 1 4 4 *", "Australia/Lord_Howe", "2026-10-18T00:00:00.000Z")).toBe("2027-04-03T14:45:00.000Z");
    expect(next("0 0 29 2 *", "Asia/Kolkata", "2026-10-16T00:00:00.000Z")).toBe("2028-02-28T18:30:00.000Z");
  });

  test("a clock that jumps across the date line or back over midnight is walked, not jumped", () => {
    // Apia skipped 2011-12-30 (UTC-10 to UTC+14): midnight on the 31st is 10:00Z on the 30th.
    expect(next("0 0 31 12 *", "Pacific/Apia", "2011-12-01T00:00:00.000Z")).toBe("2011-12-30T10:00:00.000Z");
    expect(next("0 0 31 12 *", "Pacific/Kiritimati", "1994-12-01T00:00:00.000Z")).toBe("1994-12-31T10:00:00.000Z");
    expect(next("0 12 21 8 *", "Pacific/Kwajalein", "1993-08-01T00:00:00.000Z")).toBe("1993-08-21T12:00:00.000Z");
    expect(next("0 12 22 8 *", "Pacific/Kwajalein", "1993-08-01T00:00:00.000Z")).toBe("1993-08-22T00:00:00.000Z");
    // Casey's 2010-03-05 change (UTC+11 to UTC+8 at 02:00) brought 23:00 on the 4th back.
    expect(next("* 23 4 3 *", "Antarctica/Casey", "2010-03-04T13:00:00.000Z")).toBe("2010-03-04T15:00:00.000Z");
  });

  test("one search costs calendar arithmetic, not a minute walk through nine years", () => {
    const started = performance.now();
    for (let i = 0; i < 300; i++) expect(nextOccurrence("0 0 31 2 *", "America/New_York", new Date(Date.UTC(2026, 9, 18, 0, i)))).toBeNull();
    // A day-by-day walk takes about 13 ms a search here.
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe("the tick's check (isOccurrence)", () => {
  test("a minute is an occurrence exactly when nextOccurrence from it returns it", () => {
    const expressions = ["* * * * *", "30 9 * * 1-5", "0 1-3 * * *", "*/30 * * * *", "45 1 * * *", "15 2 * * *", "30 2 * * *"];
    const zones = ["UTC", "America/New_York", "Australia/Lord_Howe"];
    // Two hours around each change, in the northern and the southern zones.
    const windows = [Date.UTC(2026, 2, 8, 6), Date.UTC(2026, 3, 4, 14), Date.UTC(2026, 9, 3, 14, 30), Date.UTC(2026, 10, 1, 5)]
      .map((start) => [start, start + 2 * 3_600_000] as const);
    for (const zone of zones) {
      for (const expr of expressions) {
        for (const [start, end] of windows) {
          for (let at = start; at < end; at += 60_000) {
            const due = nextOccurrence(expr, zone, new Date(at))?.getTime() === at;
            expect(isOccurrence(expr, zone, new Date(at + 59_000))).toBe(due);
          }
        }
      }
    }
    // An expression that names no date, and a zone Intl cannot read, have none.
    expect(isOccurrence("0 0 31 2 *", "UTC", new Date("2027-02-28T00:00:00Z"))).toBe(false);
    expect(isOccurrence("* * * * *", "Not/AZone", new Date())).toBe(false);
  });

  test("checks one minute however rare the expression, so a tick over many schedules stays short", () => {
    const started = performance.now();
    for (let i = 0; i < 2_000; i++) isOccurrence("0 0 31 2 *", "America/New_York", new Date(Date.UTC(2026, 9, 18, 12, i % 60)));
    // A forward search runs nine years for this expression (about 13 ms a call).
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
