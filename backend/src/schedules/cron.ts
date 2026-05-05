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

/** True if `date` (in server local time) matches the 5-field cron `expr`. */
export function cronMatches(expr: string, date: Date): boolean {
  const p = parse(expr);
  if (!p) return false;

  if (!p.minute.has(date.getMinutes())) return false;
  if (!p.hour.has(date.getHours())) return false;
  if (!p.month.has(date.getMonth() + 1)) return false;

  const domMatch = p.dom.has(date.getDate());
  const dowMatch = p.dow.has(date.getDay());

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
