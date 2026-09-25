import { createEvents, type EventAttributes } from "ics";

/** The task fields the calendar file needs (a subset of the pane's Task). */
export interface CalendarTask {
  uuid: string;
  text: string;
  created_at: string;
  due_at: string | null;
  source_client: string | null;
  source_excerpt: string | null;
}

/** SQLite's datetime('now') (UTC, no zone) as epoch ms. */
function sqliteUtcMs(s: string): number {
  return Date.parse(s.replace(" ", "T") + "Z");
}

/**
 * ~/.stickyinc/stickyinc.ics: every dated task as a 30-minute event at its
 * due time. Events, not to-dos: calendars ignore VTODO. The UID is the
 * task's uuid, so a refreshed subscription or a re-import updates the same
 * event rather than adding a copy, and a finished task (left out) goes away.
 */
export function calendarFile(tasks: CalendarTask[]): string {
  const events: EventAttributes[] = tasks
    .filter((t) => t.due_at)
    .map((t) => ({
      uid: `${t.uuid}@stickyinc`,
      title: t.text,
      start: Date.parse(t.due_at!),
      startInputType: "utc",
      startOutputType: "utc",
      duration: { minutes: 30 },
      created: sqliteUtcMs(t.created_at),
      description: [
        t.source_excerpt ? `“${t.source_excerpt}”` : null,
        `Added ${t.source_client ? `from ${t.source_client}` : "to StickyInc"}.`,
      ]
        .filter(Boolean)
        .join("\n"),
    }));
  const { error, value } = createEvents(events, { calName: "StickyInc", productId: "stickyinc" });
  if (error || !value) throw error ?? new Error("ics produced no output");
  return value;
}
