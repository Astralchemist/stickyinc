import * as chrono from "chrono-node";

/** ISO 8601 date or date-time: read exactly by toStoredDue, not by chrono. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/i;

/** Words that set a time of day without an hour ("tomorrow evening"). */
const PART_OF_DAY = /\b(?:morning|afternoon|evening|night|tonight|noon|midday|midnight)\b/i;

export interface Due {
  /** When it's due, UTC ISO 8601; null if the phrase isn't a date we can read. */
  at: string | null;
  /** The words it was read from, as given, so every parse can be audited. */
  phrase: string;
  /** The "now" relative words were read against, UTC ISO 8601. */
  ref: string;
}

/** UTC ISO 8601 without milliseconds, the shape the pane writes too. */
function stamp(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Normalize an ISO 8601 due date for storage, so SQL string order is time
 * order. Without an offset the time is the user's local time (JS semantics);
 * a bare date means 09:00 local on that day — JS alone would read it as UTC
 * midnight, the evening before for anyone west of UTC.
 * Returns null for anything that isn't a date.
 */
function toStoredDue(input: string): string | null {
  const s = input.trim();
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T09:00:00`) : new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return stamp(d);
}

/**
 * Work out a due date on the server rather than in the model, so the same
 * words at the same moment always give the same date; models are unreliable
 * at weekday and time-zone arithmetic. `phrase` is ISO 8601 or the user's
 * words ("tomorrow", "Friday 3pm", "in 2 hours"), read against `ref` (when
 * it was said) in the user's local time. On top of chrono's reading, a day
 * with no time of day means 09:00, or the end of the day if that's today
 * and 09:00 has passed, so "today" isn't overdue the moment it's added.
 * "End of day" means 17:00, and a bare "the 30th" the next 30th; chrono
 * alone gets those wrong or can't read them.
 */
export function resolveDue(phrase: string, ref: Date = new Date()): Due {
  const s = phrase.trim();
  const base = { phrase: s, ref: stamp(ref) };
  if (ISO_DATE.test(s)) return { ...base, at: toStoredDue(s) };

  const d = endOf(s, ref) ?? fromChrono(s.replace(HOUR_TONIGHT, "at $1 tonight"), ref) ?? dayOfMonth(s, ref);
  return { ...base, at: d && stamp(d) };
}

/** `hour` on `day`, or the end of today if that's today and already past. */
function onDay(day: Date, hour: number, ref: Date): Date {
  const d = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour);
  if (d < ref && d.toDateString() === ref.toDateString()) d.setHours(23, 59);
  return d;
}

function fromChrono(s: string, ref: Date): Date | null {
  const [result] = chrono.parse(s, ref, { forwardDate: true });
  if (!result) return null;
  if (result.start.isCertain("hour") || PART_OF_DAY.test(result.text)) return result.start.date();
  return onDay(result.start.date(), 9, ref);
}

/**
 * "9 tonight": chrono reads only "tonight" (22:00). With "at" in front it
 * takes the hour, as the evening one.
 */
const HOUR_TONIGHT = /(?<!\bat\s)\b(\d{1,2}(?::\d{2})?)\s+tonight\b/i;

/**
 * "End of day", "EOD", "close of business", "end of the week / month".
 * chrono reads "end of the day" as "the day" and lands a day, a week or a
 * month late, so these go first: 17:00 on the day (today, unless another
 * day is named), on Friday (the next one, on a weekend), or on the month's
 * last day.
 */
const END_OF = /\b(?:end\s+of\s+(?:the\s+)?(day|week|month)|eod|cob|close\s+of\s+business)\b/i;

function endOf(s: string, ref: Date): Date | null {
  const m = END_OF.exec(s);
  if (!m) return null;
  const unit = (m[1] ?? "day").toLowerCase();
  let day = ref;
  if (unit === "day") {
    const [other] = chrono.parse(s.replace(m[0], " "), ref, { forwardDate: true });
    if (other) day = other.start.date();
  } else if (unit === "week") {
    day = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() + ((5 - ref.getDay() + 7) % 7));
  } else {
    day = new Date(ref.getFullYear(), ref.getMonth() + 1, 0);
  }
  return onDay(day, 17, ref);
}

/** "The 30th", "before the 3rd": the next such day of a month, which chrono doesn't read. */
const ORDINAL_DAY = /\b(\d{1,2})(?:st|nd|rd|th)\b/i;

function dayOfMonth(s: string, ref: Date): Date | null {
  const m = ORDINAL_DAY.exec(s);
  const n = m ? Number(m[1]) : 0;
  if (n < 1 || n > 31) return null;
  for (let ahead = 0; ahead < 12; ahead++) {
    const d = new Date(ref.getFullYear(), ref.getMonth() + ahead, n);
    if (d.getDate() !== n) continue; // no 31st that month
    if (d < ref && d.toDateString() !== ref.toDateString()) continue; // already gone
    return onDay(d, 9, ref);
  }
  return null;
}

/**
 * The start of a "since" window for search: ISO 8601 or the user's words
 * ("3 weeks ago", "last month", "September 1"), read against `ref` in local
 * time and looking back, not forward. A day with no time of day means its
 * start. UTC ISO 8601, or null if the words aren't a date.
 */
export function resolveSince(phrase: string, ref: Date = new Date()): string | null {
  const s = phrase.trim();
  if (ISO_DATE.test(s)) {
    const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00`) : new Date(s);
    return Number.isNaN(d.getTime()) ? null : stamp(d);
  }
  const [result] = chrono.parse(s, ref);
  if (!result) return null;
  const start = result.start;
  const d = start.date();
  if (!start.isCertain("hour")) d.setHours(0, 0, 0, 0);
  // chrono takes the nearest match, which can be ahead: "since Monday" on a
  // Friday, or "since December 1" in September, means the last one.
  if (d > ref && start.isCertain("weekday") && !start.isCertain("day")) d.setDate(d.getDate() - 7);
  else if (d > ref && !start.isCertain("year")) d.setFullYear(d.getFullYear() - 1);
  return stamp(d);
}

/**
 * A due date as the model should relay it: local time first (a bare UTC
 * stamp gets repeated to the user as if it were local), then the exact
 * value, then the words it came from.
 */
export function describeDue(due: Due): string {
  if (!due.at) return `couldn't read "${due.phrase}" as a date, so no due date`;
  const local = new Date(due.at).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  });
  return `due ${local} (${due.at})` + (due.phrase === due.at ? "" : ` from "${due.phrase}"`);
}
