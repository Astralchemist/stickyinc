/**
 * Normalize a due date for storage: UTC ISO 8601 without milliseconds
 * ("2026-09-26T13:00:00Z"), the same shape the pane writes, so SQL string
 * order is time order. Without an offset the time is the user's local time
 * (JS semantics); a bare date means 09:00 local on that day — JS alone would
 * read it as UTC midnight, the evening before for anyone west of UTC.
 * Returns null for anything that isn't a date.
 */
export function toStoredDue(input: string): string | null {
  const s = input.trim();
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T09:00:00`) : new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * "Now" for date-parsing prompts, on the user's calendar. Models are
 * unreliable at weekday and time-zone arithmetic, so prompts ask for a local
 * date-time (converted to UTC by toStoredDue) and get the coming week's
 * dates spelled out.
 */
export function timeContext(now = new Date()): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const weekday = (d: Date) => d.toLocaleDateString("en-US", { weekday: "long" });
  const ymd = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const hm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  // Local noon on each following day, so DST changes can't skip or repeat one.
  const week = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i + 1, 12);
    return `${weekday(d)} ${ymd(d)}`;
  });
  return `Now (user's local time, ${tz}): ${weekday(now)} ${ymd(now)} ${hm}.\nThe next 7 days: ${week.join(", ")}.`;
}
