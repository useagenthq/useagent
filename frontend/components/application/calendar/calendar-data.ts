import { CalendarDate, endOfMonth, getLocalTimeZone, startOfMonth } from "@internationalized/date";

/**
 * Figma source: Board UI → "calendar_view" (node 3905:9119).
 *
 * Event data for the calendar template. August 2026's four originally
 * populated cells (2, 11, 20, 24) reproduce the Figma frame exactly —
 * "Birthday party" and "Dinner with friends" are written out in full here
 * (Figma truncates them to "Birthday p…" / "Dinner wit…" at the chip's
 * fixed 132px width — the same CSS truncation reproduces that at render
 * time), and day 20's three extra events behind "+3 more" aren't named in
 * the Figma frame (it's a static count), so plausible placeholder titles
 * fill out the real total.
 *
 * Everything else (the rest of August plus May 2026 – Jan 2027) is
 * generated showcase data, not from Figma — titles kept short (one or two
 * short words) so they never need the chip's truncation.
 */

export type CalendarEventColor = "blue" | "pink" | "lime" | "purple" | "emerald";

/** Matches the tint pairs `Avatar` already ships (neutral/lime/pink), plus
 *  one exception the event-details modal itself uses (blue-200/blue-500 —
 *  `Avatar`'s own "blue" is blue-300/blue-900, a different pair) that isn't
 *  worth adding to the shared component for one modal's fourth attendee. */
export type ParticipantColor = "neutral" | "lime" | "pink" | "blue";

export interface EventParticipant {
  email: string;
  initials: string;
  color: ParticipantColor;
}

export interface CalendarEvent {
  id: string;
  title: string;
  /** 24h "HH:mm"; omitted for all-day events (e.g. "Holidays"). */
  time?: string;
  /** 24h "HH:mm". Defaults to a generated duration (see `generatedEndTime`)
   *  when `time` is set and this is omitted. */
  endTime?: string;
  color: CalendarEventColor;
  /** Google Meet code, e.g. "igc-mfrq-sse". Defaults to a deterministic
   *  generated-looking code (see `eventDetails`) when `time` is set. */
  meetingCode?: string;
  /** Defaults to a generated 2–5 person roster when `time` is set (see
   *  `generatedParticipants`). */
  participants?: EventParticipant[];
  /** Defaults to "2h before" when `time` is set. */
  reminder?: string;
  /** Cover photo for the event-details modal's "image_area" (node
   *  3920:11026) — most events don't have one; only set where Figma
   *  actually shows an image. */
  image?: string;
}

/** Same small hash-combine technique as `ContributionsCard`'s `hashCell` —
 *  deterministic (SSR-safe, no `Math.random`) so a generated meeting code
 *  is stable for a given event id instead of changing every render. */
function hashString(input: string) {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = Math.imul(h ^ input.charCodeAt(i), 2654435761);
  }
  return (h ^ (h >>> 16)) >>> 0;
}

const CODE_ALPHABET = "abcdefghijklmnopqrstuvwxyz";
function codeSegment(seed: number, length: number) {
  let out = "";
  let n = seed;
  for (let i = 0; i < length; i++) {
    out += CODE_ALPHABET[n % CODE_ALPHABET.length];
    n = Math.floor(n / CODE_ALPHABET.length) || hashString(out);
  }
  return out;
}

/** Deterministic "xxx-xxxx-xxx"-style meeting code from an event id — same
 *  shape as Figma's example ("igc-mfrq-sse"), never a real Google Meet
 *  link. */
function generatedMeetingCode(id: string) {
  const seed = hashString(id);
  return `${codeSegment(seed, 3)}-${codeSegment(seed >>> 8, 4)}-${codeSegment(seed >>> 16, 3)}`;
}

/** First-name-only pool for the generated attendee lists below — plausible
 *  handles across a spread of free-mail providers, not real people. */
const PARTICIPANT_POOL: { name: string; domain: string }[] = [
  { name: "stevenrule", domain: "gmail.com" },
  { name: "laurenprosso", domain: "outlook.com" },
  { name: "jasonclay", domain: "gmail.com" },
  { name: "mayaflores", domain: "icloud.com" },
  { name: "davidkim", domain: "gmail.com" },
  { name: "ninapatel", domain: "outlook.com" },
  { name: "ericsong", domain: "yahoo.com" },
  { name: "oliviabrooks", domain: "gmail.com" },
  { name: "samuelortiz", domain: "icloud.com" },
  { name: "zoeharper", domain: "gmail.com" },
];

const PARTICIPANT_COLORS: ParticipantColor[] = ["lime", "pink", "blue", "neutral"];

/** Deterministic (per event id) 2–5 person attendee list — always leads
 *  with the organizer (`hi@mertcan.works`), then a hash-picked run through
 *  `PARTICIPANT_POOL` so the size and roster vary per event but stay
 *  stable across renders/SSR instead of using `Math.random`. */
function generatedParticipants(id: string): EventParticipant[] {
  const seed = hashString(id);
  const count = 2 + (seed % 4); // 2..5, inclusive
  const start = (seed >>> 8) % PARTICIPANT_POOL.length;
  const participants: EventParticipant[] = [
    { email: "hi@mertcan.works", initials: "M", color: "neutral" },
  ];
  for (let i = 0; i < count - 1; i++) {
    const person = PARTICIPANT_POOL[(start + i) % PARTICIPANT_POOL.length];
    participants.push({
      email: `${person.name}@${person.domain}`,
      initials: person.name[0].toUpperCase(),
      color: PARTICIPANT_COLORS[(start + i) % PARTICIPANT_COLORS.length],
    });
  }
  return participants;
}

function addMinutes(time: string, minutes: number): string {
  const [h, m] = time.split(":").map(Number);
  const total = (h * 60 + m + minutes) % (24 * 60);
  const nh = Math.floor(total / 60);
  const nm = total % 60;
  return `${String(nh).padStart(2, "0")}:${String(nm).padStart(2, "0")}`;
}

/** 45m, 1h, 1h15, 1h30, 2h, 2h15, 2h45 — a spread of plausible meeting
 *  lengths, picked deterministically per event id (see `generatedParticipants`
 *  for the same technique) so durations vary across events instead of every
 *  event defaulting to a flat 1h. */
const DURATION_MINUTES_OPTIONS = [45, 60, 75, 90, 120, 135, 165];

function generatedEndTime(id: string, time: string): string {
  const seed = hashString(`${id}-duration`);
  const minutes = DURATION_MINUTES_OPTIONS[seed % DURATION_MINUTES_OPTIONS.length];
  return addMinutes(time, minutes);
}

export interface ResolvedEventDetails {
  endTime: string | null;
  meetingCode: string | null;
  participants: EventParticipant[];
  reminder: string | null;
}

/** Fills in the modal's defaults for a timed event; all-day events (no
 *  `time`) get no meeting/participants/reminder — Figma's example is a
 *  timed event, and there's no all-day variant of this modal to match. */
export function eventDetails(event: CalendarEvent): ResolvedEventDetails {
  if (!event.time) {
    return { endTime: null, meetingCode: null, participants: [], reminder: null };
  }
  return {
    endTime: event.endTime ?? generatedEndTime(event.id, event.time),
    meetingCode: event.meetingCode ?? generatedMeetingCode(event.id),
    participants: event.participants ?? generatedParticipants(event.id),
    reminder: event.reminder ?? "2h before",
  };
}

const AUG = 8;

export const CALENDAR_EVENTS: Record<string, CalendarEvent[]> = {
  // May 2026
  "2026-05-01": [{ id: "may-01-standup", title: "Standup", time: "09:00", color: "pink" }],
  "2026-05-04": [
    { id: "may-04-standup", title: "Standup", time: "09:00", color: "blue" },
    { id: "may-04-gym", title: "Gym", time: "18:00", color: "pink" },
  ],
  "2026-05-07": [{ id: "may-07-design-sync", title: "Design sync", time: "13:30", color: "blue" }],
  "2026-05-08": [
    { id: "may-08-sprint-planning", title: "Sprint planning", time: "10:00", color: "emerald" },
    { id: "may-08-1-1", title: "1:1", time: "15:00", color: "lime" },
  ],
  "2026-05-12": [{ id: "may-12-dentist", title: "Dentist", time: "10:30", color: "emerald" }],
  "2026-05-14": [{ id: "may-14-yoga", title: "Yoga", time: "07:30", color: "pink" }],
  "2026-05-15": [{ id: "may-15-vendor-demo", title: "Vendor demo", time: "11:00", color: "blue" }],
  "2026-05-19": [{ id: "may-19-book-club", title: "Book club", time: "19:00", color: "purple" }],
  "2026-05-21": [
    { id: "may-21-standup", title: "Standup", time: "09:00", color: "pink" },
    { id: "may-21-lunch", title: "Team lunch", time: "12:30", color: "lime" },
  ],
  "2026-05-25": [{ id: "may-25-holiday", title: "Holiday", color: "emerald" }],
  "2026-05-26": [{ id: "may-26-brunch", title: "Brunch", time: "11:00", color: "lime" }],
  "2026-05-27": [{ id: "may-27-payday", title: "Payday", color: "lime" }],
  "2026-05-29": [{ id: "may-29-movie-night", title: "Movie night", time: "20:00", color: "purple" }],

  // June 2026
  "2026-06-01": [{ id: "jun-01-standup", title: "Standup", time: "09:00", color: "pink" }],
  "2026-06-03": [{ id: "jun-03-sync", title: "Sync", time: "09:30", color: "blue" }],
  "2026-06-05": [{ id: "jun-05-gym", title: "Gym", time: "07:00", color: "pink" }],
  "2026-06-09": [{ id: "jun-09-yoga", title: "Yoga", time: "07:30", color: "pink" }],
  "2026-06-11": [
    { id: "jun-11-planning", title: "Planning", time: "10:00", color: "blue" },
    { id: "jun-11-client-call", title: "Client call", time: "14:00", color: "emerald" },
  ],
  "2026-06-15": [
    { id: "jun-15-demo", title: "Demo", time: "14:00", color: "blue" },
    { id: "jun-15-lunch", title: "Lunch", time: "12:30", color: "lime" },
  ],
  "2026-06-18": [{ id: "jun-18-dentist", title: "Dentist", time: "10:30", color: "emerald" }],
  "2026-06-19": [{ id: "jun-19-haircut", title: "Haircut", time: "16:00", color: "emerald" }],
  "2026-06-22": [{ id: "jun-22-picnic", title: "Picnic", time: "12:00", color: "lime" }],
  "2026-06-24": [{ id: "jun-24-retro", title: "Retro", time: "15:00", color: "blue" }],
  "2026-06-28": [{ id: "jun-28-concert", title: "Concert", time: "20:00", color: "purple" }],
  "2026-06-30": [
    { id: "jun-30-standup", title: "Standup", time: "09:00", color: "pink" },
    { id: "jun-30-payday", title: "Payday", color: "lime" },
  ],

  // July 2026
  "2026-07-01": [{ id: "jul-01-kickoff", title: "Kickoff", time: "09:00", color: "blue" }],
  "2026-07-04": [{ id: "jul-04-holiday", title: "Holiday", color: "emerald" }],
  "2026-07-08": [{ id: "jul-08-sync", title: "Sync", time: "09:30", color: "blue" }],
  "2026-07-10": [{ id: "jul-10-vet-visit", title: "Vet visit", time: "10:00", color: "emerald" }],
  "2026-07-11": [{ id: "jul-11-game-night", title: "Game night", time: "19:00", color: "purple" }],
  "2026-07-14": [{ id: "jul-14-standup", title: "Standup", time: "09:00", color: "pink" }],
  "2026-07-17": [
    { id: "jul-17-design-review", title: "Design review", time: "11:00", color: "blue" },
    { id: "jul-17-team-lunch", title: "Team lunch", time: "13:00", color: "purple" },
  ],
  "2026-07-18": [{ id: "jul-18-brunch", title: "Brunch", time: "11:00", color: "lime" }],
  "2026-07-21": [{ id: "jul-21-yoga", title: "Yoga", time: "07:30", color: "pink" }],
  "2026-07-25": [{ id: "jul-25-movie-night", title: "Movie night", time: "20:00", color: "purple" }],
  "2026-07-28": [{ id: "jul-28-coffee", title: "Coffee", time: "09:30", color: "lime" }],
  "2026-07-30": [{ id: "jul-30-payday", title: "Payday", color: "lime" }],

  // August 2026 (2, 11, 20, 24 are the original Figma cells)
  "2026-08-01": [{ id: "aug-01-brunch", title: "Brunch", time: "11:00", color: "lime" }],
  "2026-08-02": [
    { id: "standup-2", title: "Stand-up", time: "11:30", color: "pink" },
    { id: "sync-2", title: "1:1 sync", time: "16:30", color: "lime" },
  ],
  "2026-08-05": [{ id: "aug-05-gym", title: "Gym", time: "07:00", color: "pink" }],
  "2026-08-08": [{ id: "aug-08-game-night", title: "Game night", time: "19:00", color: "purple" }],
  "2026-08-11": [
    { id: "holidays", title: "Holidays", color: "emerald" },
    {
      id: "birthday",
      // Figma's own event-details modal example (node 3920:10954) is this
      // exact event — title, times, meeting code, and reminder all
      // reproduced verbatim so opening it from the day cell matches 1:1.
      title: "Birthday night at Bacalar’s",
      time: "20:30",
      endTime: "23:30",
      color: "purple",
      meetingCode: "igc-mfrq-sse",
      reminder: "2h before",
      // "image_area" (node 3920:11026) — the venue photo Figma's example
      // shows above the Google Meet row.
      image: "/calendar/birthday-event.png",
      // Figma's own event-details modal example (node 3920:10954) pins this
      // exact 4-person roster — kept explicit so it doesn't drift when
      // `generatedParticipants` changes.
      participants: [
        { email: "hi@mertcan.works", initials: "M", color: "neutral" },
        { email: "stevenrule@gmail.com", initials: "S", color: "lime" },
        { email: "laurenprosso@outlook.com", initials: "L", color: "pink" },
        { email: "jasonclay@gmail.com", initials: "J", color: "blue" },
      ],
    },
  ],
  "2026-08-14": [{ id: "aug-14-retro", title: "Retro", time: "15:00", color: "blue" }],
  "2026-08-17": [
    { id: "aug-17-planning", title: "Planning", time: "10:00", color: "blue" },
    { id: "aug-17-haircut", title: "Haircut", time: "16:00", color: "emerald" },
  ],
  "2026-08-20": [
    { id: "design-review", title: "Design review", time: "09:30", color: "blue" },
    { id: "client-call", title: "Client call", time: "10:15", color: "emerald" },
    { id: "team-lunch", title: "Team lunch", time: "13:00", color: "purple" },
    { id: "standup-20", title: "Stand-up", time: "11:30", color: "pink" },
    { id: "sync-20", title: "1:1 sync", time: "16:30", color: "lime" },
    { id: "portfolio-review", title: "Portfolio review", time: "14:30", color: "blue" },
  ],
  "2026-08-24": [
    { id: "dinner", title: "Dinner with friends", time: "19:15", color: "purple" },
  ],
  "2026-08-27": [{ id: "aug-27-yoga", title: "Yoga", time: "07:30", color: "pink" }],
  "2026-08-29": [{ id: "aug-29-brunch", title: "Brunch", time: "11:00", color: "lime" }],
  "2026-08-31": [{ id: "aug-31-payday", title: "Payday", color: "lime" }],

  // September 2026
  "2026-09-01": [{ id: "sep-01-kickoff", title: "Kickoff", time: "09:00", color: "blue" }],
  "2026-09-02": [{ id: "sep-02-standup", title: "Standup", time: "09:00", color: "pink" }],
  "2026-09-04": [{ id: "sep-04-dentist", title: "Dentist", time: "10:30", color: "emerald" }],
  "2026-09-08": [{ id: "sep-08-planning", title: "Planning", time: "10:00", color: "blue" }],
  "2026-09-10": [
    { id: "sep-10-design-review", title: "Design review", time: "11:00", color: "blue" },
    { id: "sep-10-client-call", title: "Client call", time: "14:00", color: "emerald" },
  ],
  "2026-09-11": [{ id: "sep-11-gym", title: "Gym", time: "07:00", color: "pink" }],
  "2026-09-15": [{ id: "sep-15-haircut", title: "Haircut", time: "16:00", color: "emerald" }],
  "2026-09-17": [{ id: "sep-17-book-club", title: "Book club", time: "19:00", color: "purple" }],
  "2026-09-21": [{ id: "sep-21-game-night", title: "Game night", time: "19:00", color: "purple" }],
  "2026-09-24": [
    { id: "sep-24-standup", title: "Standup", time: "09:00", color: "pink" },
    { id: "sep-24-lunch", title: "Team lunch", time: "12:30", color: "lime" },
  ],
  "2026-09-25": [{ id: "sep-25-retro", title: "Retro", time: "15:00", color: "blue" }],
  "2026-09-29": [{ id: "sep-29-coffee", title: "Coffee", time: "09:30", color: "lime" }],
  "2026-09-30": [{ id: "sep-30-payday", title: "Payday", color: "lime" }],

  // October 2026
  "2026-10-06": [{ id: "oct-06-sync", title: "Sync", time: "09:30", color: "blue" }],
  "2026-10-13": [{ id: "oct-13-dentist", title: "Dentist", time: "11:00", color: "emerald" }],
  "2026-10-19": [{ id: "oct-19-concert", title: "Concert", time: "19:30", color: "purple" }],
  "2026-10-27": [{ id: "oct-27-lunch", title: "Lunch", time: "12:30", color: "lime" }],
  "2026-10-31": [{ id: "oct-31-halloween", title: "Halloween", time: "18:00", color: "purple" }],

  // November 2026
  "2026-11-03": [{ id: "nov-03-standup", title: "Standup", time: "09:00", color: "pink" }],
  "2026-11-10": [{ id: "nov-10-demo", title: "Demo", time: "14:00", color: "blue" }],
  "2026-11-17": [{ id: "nov-17-vet-visit", title: "Vet visit", time: "10:00", color: "emerald" }],
  "2026-11-24": [{ id: "nov-24-game-night", title: "Game night", time: "19:00", color: "purple" }],
  "2026-11-26": [{ id: "nov-26-holiday", title: "Holiday", color: "emerald" }],

  // December 2026
  "2026-12-01": [{ id: "dec-01-sync", title: "Sync", time: "09:00", color: "blue" }],
  "2026-12-08": [{ id: "dec-08-shopping", title: "Shopping", time: "15:00", color: "lime" }],
  "2026-12-15": [{ id: "dec-15-party", title: "Party", time: "19:00", color: "purple" }],
  "2026-12-22": [{ id: "dec-22-holidays", title: "Holidays", color: "emerald" }],
  "2026-12-25": [{ id: "dec-25-holiday", title: "Holiday", color: "emerald" }],
  "2026-12-31": [{ id: "dec-31-countdown", title: "Countdown", time: "22:00", color: "purple" }],

  // January 2027
  "2027-01-04": [{ id: "jan-04-standup", title: "Standup", time: "09:00", color: "pink" }],
  "2027-01-12": [{ id: "jan-12-planning", title: "Planning", time: "10:00", color: "blue" }],
  "2027-01-20": [{ id: "jan-20-review", title: "Review", time: "14:00", color: "lime" }],
};

export const CALENDAR_SHOWCASE_MONTH = new CalendarDate(2026, AUG, 1);

function dateKey(date: CalendarDate) {
  return `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

/** Earliest first — all-day events (no `time`) sort ahead of timed ones,
 *  since `undefined ?? ""` sorts before any "HH:mm" string. */
export function eventsForDate(date: CalendarDate): CalendarEvent[] {
  const events = CALENDAR_EVENTS[dateKey(date)] ?? [];
  return [...events].sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""));
}

/**
 * Sun-start, always-6-row (42-day) month grid: every day from the Sunday
 * on/before the 1st through the Saturday on/after the last day, padded with
 * extra trailing days from the next month whenever that span is fewer than
 * 6 weeks — so the grid (and the card around it) is always the exact same
 * height across every month instead of flipping between 5 and 6 rows.
 * Leading/trailing days outside the shown month are greyed out by
 * `isCurrentMonth` in `CalendarMonthGrid`, not by anything here.
 */
const MIN_ROWS = 6;

export function monthGrid(monthStart: CalendarDate): CalendarDate[] {
  const tz = getLocalTimeZone();
  const first = startOfMonth(monthStart);
  const last = endOfMonth(monthStart);
  const firstWeekday = first.toDate(tz).getDay();
  const lastWeekday = last.toDate(tz).getDay();

  const gridStart = first.subtract({ days: firstWeekday });
  let gridEnd = last.add({ days: 6 - lastWeekday });

  const days: CalendarDate[] = [];
  for (let d = gridStart; d.compare(gridEnd) <= 0; d = d.add({ days: 1 })) {
    days.push(d);
  }

  while (days.length < MIN_ROWS * 7) {
    for (let i = 0; i < 7; i++) {
      gridEnd = gridEnd.add({ days: 1 });
      days.push(gridEnd);
    }
  }

  return days;
}

export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
