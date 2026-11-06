// Ported from KiroCrew (https://github.com/kirodotdev/KiroCrew), Apache-2.0:
//   src/kiro_crew/cron.py
// Copyright Amazon.com, Inc. or its affiliates. Changed: rewritten in
// TypeScript for this codebase. License and NOTICE: third_party/licenses/kirocrew/.
// KiroCrew's `cron_expr_matches` / `validate_cron_expr` delegate to the croniter
// dependency; here they are reimplemented as a dependency-free 5-field matcher
// with the same semantics (standard Vixie cron, including the dom/dow OR rule).

/**
 * Expand one cron field into the set of matching integers within [min, max].
 * Supports `*`, `*​/n`, `a`, `a-b`, `a-b/n`, `a/n` (a→max step n), and comma
 * lists of any of those. Returns `null` on any syntax error (out-of-range,
 * malformed, reversed range, non-positive step).
 */
function expandField(field: string, min: number, max: number): Set<number> | null {
  if (field === "") return null;
  const out = new Set<number>();

  for (const part of field.split(",")) {
    if (part === "") return null;

    // Optional `/step` suffix.
    let range = part;
    let step = 1;
    const slash = part.indexOf("/");
    if (slash !== -1) {
      range = part.slice(0, slash);
      step = Number(part.slice(slash + 1));
      if (!Number.isInteger(step) || step <= 0) return null;
    }

    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = min;
      hi = max;
    } else if (range.includes("-")) {
      const bounds = range.split("-");
      if (bounds.length !== 2) return null;
      lo = Number(bounds[0]);
      hi = Number(bounds[1]);
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) return null;
    } else {
      lo = Number(range);
      if (!Number.isInteger(lo)) return null;
      // A bare value with a step ("5/10") means "from 5 to max, every 10".
      hi = slash !== -1 ? max : lo;
    }

    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }

  return out;
}

interface ParsedCron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
  /** Neither the minute nor the hour field starts with `*`: the expression
   *  names wall-clock times rather than a period (Vixie cron's distinction). */
  fixedTime: boolean;
}

/** Split + validate a 5-field expression into its expanded sets, or `null`. */
function parse(expr: string): ParsedCron | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minF, hourF, domF, monF, dowF] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];

  const minute = expandField(minF, 0, 59);
  const hour = expandField(hourF, 0, 23);
  const dom = expandField(domF, 1, 31);
  const month = expandField(monF, 1, 12);
  const dow = expandField(dowF, 0, 7);
  if (!minute || !hour || !dom || !month || !dow) return null;

  // DOW is 0–7 with both 0 and 7 meaning Sunday; normalize 7 → 0 so it matches
  // JS `Date.getDay()` (0–6).
  if (dow.has(7)) dow.add(0);

  return {
    minute,
    hour,
    dom,
    month,
    dow,
    domRestricted: domF !== "*",
    dowRestricted: dowF !== "*",
    fixedTime: !minF.startsWith("*") && !hourF.startsWith("*"),
  };
}

/** The cron-relevant wall-clock fields of an instant, and the zone's offset there. */
interface WallClock {
  year: number;
  month: number;
  dom: number;
  hour: number;
  minute: number;
  dow: number; // 0 = Sunday … 6 = Saturday (matches Date.getDay)
  /** Minutes east of UTC at this instant. */
  offset: number;
}

const MINUTE_MS = 60_000;
const MINUTES_PER_DAY = 24 * 60;

const WEEKDAY: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** One formatter per zone (building one is the expensive part); null for a
 *  zone Intl rejects. */
const zoneFormatters = new Map<string, Intl.DateTimeFormat | null>();

function zoneFormatter(timeZone: string): Intl.DateTimeFormat | null {
  let formatter = zoneFormatters.get(timeZone);
  if (formatter === undefined) {
    try {
      formatter = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        weekday: "short",
      });
    } catch {
      formatter = null;
    }
    zoneFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/** Wall-clock fields of the instant `at` (epoch ms), read by a zone's formatter. */
function wallClock(at: number, zone: Intl.DateTimeFormat): WallClock {
  const parts = zone.formatToParts(at);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  const wall = {
    year: Number(get("year")),
    month: Number(get("month")),
    dom: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
  };
  const utcMinute = Math.floor(at / MINUTE_MS) * MINUTE_MS;
  return {
    ...wall,
    dow: WEEKDAY[get("weekday")] ?? new Date(at).getUTCDay(),
    offset: (Date.UTC(wall.year, wall.month - 1, wall.dom, wall.hour, wall.minute) - utcMinute) / MINUTE_MS,
  };
}

function dayMatches(p: ParsedCron, wc: Pick<WallClock, "dom" | "month" | "dow">): boolean {
  if (!p.month.has(wc.month)) return false;
  const domMatch = p.dom.has(wc.dom);
  const dowMatch = p.dow.has(wc.dow);
  // Vixie cron: when BOTH day-of-month and day-of-week are restricted, the day
  // matches if EITHER does; otherwise a restricted field must match (a `*`
  // field never restricts).
  if (p.domRestricted && p.dowRestricted) return domMatch || dowMatch;
  return domMatch && dowMatch;
}

function fieldsMatch(p: ParsedCron, wc: Pick<WallClock, "minute" | "hour" | "dom" | "month" | "dow">): boolean {
  return p.minute.has(wc.minute) && p.hour.has(wc.hour) && dayMatches(p, wc);
}

/**
 * True if `date`'s wall clock in `timeZone` (an IANA name) matches the 5-field
 * cron `expr`; false for a zone Intl cannot read. Every schedule names its
 * zone, so its wall-clock intent never depends on where the box runs. This is
 * the field matcher; which instants are occurrences (DST repeats and gaps
 * included) is {@link nextOccurrence}'s answer.
 */
export function cronMatches(expr: string, date: Date, timeZone: string): boolean {
  const p = parse(expr);
  const zone = zoneFormatter(timeZone);
  return p && zone ? fieldsMatch(p, wallClock(date.getTime(), zone)) : false;
}

/** Far enough ahead to pass the longest gap a valid expression can have:
 *  February 29 across 2100, eight years. */
const OCCURRENCE_HORIZON_MS = 9 * 366 * MINUTES_PER_DAY * MINUTE_MS;
/** Longer than any DST shift (Antarctica/Troll moves two hours). */
const SHIFT_LOOKBACK_MS = 3 * 60 * MINUTE_MS;

/** A fall-back read this wall time once already: the zone's offset dropped by
 *  `shift` within the lookback, and the instant `shift` earlier still had the
 *  old offset, so it showed the same wall clock. */
function repeatsEarlierWallTime(at: number, wc: WallClock, zone: Intl.DateTimeFormat): boolean {
  const before = wallClock(at - SHIFT_LOOKBACK_MS, zone);
  const shift = before.offset - wc.offset;
  return shift > 0 && wallClock(at - shift * MINUTE_MS, zone).offset === before.offset;
}

/** A spring-forward skipped `gap` wall-clock minutes just before this instant;
 *  does one of them match? `last` is the wall clock a minute earlier. */
function skippedWallTimeMatches(p: ParsedCron, last: WallClock, gap: number): boolean {
  const lastMinute = Date.UTC(last.year, last.month - 1, last.dom, last.hour, last.minute);
  for (let k = 1; k <= gap; k++) {
    const skipped = new Date(lastMinute + k * MINUTE_MS); // calendar arithmetic, read back in UTC
    if (
      fieldsMatch(p, {
        minute: skipped.getUTCMinutes(),
        hour: skipped.getUTCHours(),
        dom: skipped.getUTCDate(),
        month: skipped.getUTCMonth() + 1,
        dow: skipped.getUTCDay(),
      })
    ) {
      return true;
    }
  }
  return false;
}

/** Whether the day fields match the calendar date `days` after the wall-clock
 *  date of `wc` (before it when negative), by calendar arithmetic alone: a
 *  date's weekday is the same in every zone. */
function matchesDateFrom(p: ParsedCron, wc: WallClock, days: number): boolean {
  const date = new Date(Date.UTC(wc.year, wc.month - 1, wc.dom + days));
  return dayMatches(p, { dom: date.getUTCDate(), month: date.getUTCMonth() + 1, dow: date.getUTCDay() });
}

/** Days from the wall-clock date of `wc` to the next date whose day fields
 *  match; null when none comes within `maxDays`. */
function daysToMatchingDate(p: ParsedCron, wc: WallClock, maxDays: number): number | null {
  for (let ahead = 1; ahead <= maxDays; ahead++) if (matchesDateFrom(p, wc, ahead)) return ahead;
  return null;
}

/** Whether the whole minute `at` (its wall clock `wc`; the zone's offset a
 *  minute earlier `previousOffset`) is an occurrence of `p`: the rule
 *  nextOccurrence applies to each minute it passes and isOccurrence to one. */
function occursAt(p: ParsedCron, zone: Intl.DateTimeFormat, at: number, wc: WallClock, previousOffset: number): boolean {
  if (fieldsMatch(p, wc)) return !p.fixedTime || !repeatsEarlierWallTime(at, wc, zone);
  return (
    p.fixedTime &&
    wc.offset > previousOffset &&
    skippedWallTimeMatches(p, wallClock(at - MINUTE_MS, zone), wc.offset - previousOffset)
  );
}

/**
 * The first occurrence of `expr` at or after `from` (rounded up to a whole
 * minute), or null when it has none within the horizon (February 30) or Intl
 * cannot read `timeZone`. The one definition of an occurrence: the scheduler
 * fires in the minutes it names (isOccurrence asks the same of one minute),
 * and the API shows the next of them as a schedule's next run.
 *
 * An occurrence is a whole minute whose wall clock in `timeZone` matches the
 * fields (the same matcher as {@link cronMatches}). Across a DST change a
 * fixed-time expression (no `*` in the minute or hour field) fires once per
 * named wall-clock time: in a fall-back only the first reading of a repeated
 * time counts, and a time a spring-forward skips fires at the first minute
 * after the gap. A periodic expression keeps real time: it fires in both
 * readings of a repeated hour and nothing stands in for skipped minutes.
 * That is Vixie cron's rule.
 */
export function nextOccurrence(expr: string, timeZone: string, from: Date): Date | null {
  const p = parse(expr);
  const zone = zoneFormatter(timeZone);
  if (!p || !zone) return null;
  const end = from.getTime() + OCCURRENCE_HORIZON_MS;
  let at = Math.ceil(from.getTime() / MINUTE_MS) * MINUTE_MS;
  let previousOffset = wallClock(at - MINUTE_MS, zone).offset;
  let wc = wallClock(at, zone);
  while (at <= end) {
    if (occursAt(p, zone, at, wc, previousOffset)) return new Date(at);
    // A run of days the day fields rule out is passed by calendar arithmetic:
    // the walk resumes at noon on the day before the next date they name. It
    // jumps only where a day-by-day walk would see the same dates: not while
    // one of the two dates before this one matches (a clock set back past
    // midnight can bring it back), and only when it lands on that day before
    // (otherwise an offset change of half a day or more, the date line, lies
    // between). Where it does not jump, the walk below takes the next day.
    if (!dayMatches(p, wc) && !matchesDateFrom(p, wc, -1) && !matchesDateFrom(p, wc, -2)) {
      const ahead = daysToMatchingDate(p, wc, Math.ceil((end - at) / (MINUTES_PER_DAY * MINUTE_MS)) + 1);
      if (ahead === null) return null;
      if (ahead > 1) {
        const target = Date.UTC(wc.year, wc.month - 1, wc.dom + ahead - 1, 12) - wc.offset * MINUTE_MS;
        const landed = wallClock(target, zone);
        if (target > at && Date.UTC(landed.year, landed.month - 1, landed.dom) === Date.UTC(wc.year, wc.month - 1, wc.dom + ahead - 1)) {
          at = target;
          previousOffset = wallClock(at - MINUTE_MS, zone).offset;
          wc = landed;
          continue;
        }
      }
    }
    // Skip to the next wall-clock midnight or hour when this day or hour cannot
    // match, but only when the offset is the same at both ends: then no DST
    // change lies between, every minute passed read the same day or hour, and
    // none was a skipped or repeated time. Otherwise step one minute.
    const span = !dayMatches(p, wc)
      ? MINUTES_PER_DAY - (wc.hour * 60 + wc.minute)
      : p.hour.has(wc.hour)
        ? 1
        : 60 - wc.minute;
    let step = span;
    let next = wallClock(at + span * MINUTE_MS, zone);
    if (span > 1 && next.offset !== wc.offset) {
      step = 1;
      next = wallClock(at + MINUTE_MS, zone);
    }
    previousOffset = step === 1 ? wc.offset : next.offset;
    at += step * MINUTE_MS;
    wc = next;
  }
  return null;
}

/** True if the whole minute containing `at` is an occurrence of `expr` in
 *  `timeZone`, the minute nextOccurrence would return from its start: the
 *  scheduler tick's check, one minute's work however rare the expression. */
export function isOccurrence(expr: string, timeZone: string, at: Date): boolean {
  const p = parse(expr);
  const zone = zoneFormatter(timeZone);
  if (!p || !zone) return false;
  const minute = Math.floor(at.getTime() / MINUTE_MS) * MINUTE_MS;
  return occursAt(p, zone, minute, wallClock(minute, zone), wallClock(minute - MINUTE_MS, zone).offset);
}

/** True if `expr` is a syntactically valid 5-field cron expression. */
export function isValidCron(expr: string): boolean {
  return parse(expr) !== null;
}

/** True if `tz` is an IANA timezone Intl accepts (empty/undefined → false). */
export function isValidTimezone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
