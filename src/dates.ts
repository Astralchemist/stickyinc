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
 */
export function resolveDue(phrase: string, ref: Date = new Date()): Due {
  const s = phrase.trim();
  const base = { phrase: s, ref: stamp(ref) };
  if (ISO_DATE.test(s)) return { ...base, at: toStoredDue(s) };

  const [result] = chrono.parse(s, ref, { forwardDate: true });
  if (!result) return { ...base, at: null };
  let d = result.start.date();
  if (!result.start.isCertain("hour") && !PART_OF_DAY.test(result.text)) {
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 9);
    if (d < ref && d.toDateString() === ref.toDateString()) d.setHours(23, 59);
  }
  return { ...base, at: stamp(d) };
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
