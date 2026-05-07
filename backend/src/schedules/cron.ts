// Ported from reference bot (Apache-2.0): src/kiro_crew/cron.py
// reference bot's `cron_expr_matches` / `validate_cron_expr` delegate to the croniter
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

/** Split + validate a 5-field expression into its expanded sets, or `null`. */
function parse(expr: string): {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
} | null {
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
  };
}

/** The cron-relevant wall-clock fields of an instant. */
interface WallClock {
  minute: number;
  hour: number;
  dom: number;
  month: number;
  dow: number; // 0 = Sunday … 6 = Saturday (matches Date.getDay)
}

const WEEKDAY: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** Wall-clock fields in server LOCAL time (the pre-timezone behavior). */
function localWallClock(date: Date): WallClock {
  return {
    minute: date.getMinutes(),
    hour: date.getHours(),
    dom: date.getDate(),
    month: date.getMonth() + 1,
    dow: date.getDay(),
  };
}

/**
 * Wall-clock fields of `date` as seen in IANA `timeZone`, dependency-free via
 * `Intl.DateTimeFormat`. An invalid/unknown zone throws when the formatter is
 * built — we fall back to server local time (defensive: a bad zone must never
 * break the whole scheduler tick; the API validates the zone before it persists).
 */
function zonedWallClock(date: Date, timeZone: string): WallClock {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    }).formatToParts(date);
    const get = (type: string): string =>
      parts.find((p) => p.type === type)?.value ?? "";
    return {
      minute: Number(get("minute")),
      hour: Number(get("hour")),
      dom: Number(get("day")),
      month: Number(get("month")),
      dow: WEEKDAY[get("weekday")] ?? date.getUTCDay(),
    };
  } catch {
    return localWallClock(date);
  }
}

/**
 * True if `date` matches the 5-field cron `expr`. Evaluated in `timeZone` (an
 * IANA name) when given, else in server local time. The timezone makes a
 * schedule's wall-clock intent independent of where the box runs (mem_op 0.4).
 */
export function cronMatches(
  expr: string,
  date: Date,
  timeZone?: string | null,
): boolean {
  const p = parse(expr);
  if (!p) return false;

  const wc = timeZone ? zonedWallClock(date, timeZone) : localWallClock(date);
  if (!p.minute.has(wc.minute)) return false;
  if (!p.hour.has(wc.hour)) return false;
  if (!p.month.has(wc.month)) return false;

  const domMatch = p.dom.has(wc.dom);
  const dowMatch = p.dow.has(wc.dow);

  // Vixie cron: when BOTH day-of-month and day-of-week are restricted, the day
  // matches if EITHER does; otherwise a restricted field must match (a `*`
  // field never restricts).
  if (p.domRestricted && p.dowRestricted) {
    return domMatch || dowMatch;
  }
  return domMatch && dowMatch;
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
