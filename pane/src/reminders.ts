/** When to send native notifications for dated tasks. No Tauri imports, so it can be tested alone. */

export interface ReminderTask {
  uuid: string;
  text: string;
  created_at: string;
  due_at: string | null;
}

export interface Reminder {
  /** uuid|due_at|kind: sent once per due time, so a snoozed task reminds again. */
  key: string;
  kind: "day-before" | "due";
  task: ReminderTask;
}

const HOUR = 3_600_000;
/** How late a reminder may still go out, e.g. after the machine slept through it. */
export const GRACE_MS = HOUR;

/**
 * Reminders to send at `now`: 24 hours before each dated task is due, and
 * when it's due. Each goes out once (`sent` holds keys already sent), only
 * if the task existed before that moment (no "due now" for a task added
 * overdue), and only within GRACE_MS of it, so opening the pane after days
 * away doesn't bring a burst of stale ones; the strip's red dot covers those.
 */
export function remindersDue(tasks: ReminderTask[], now: number, sent: Set<string>): Reminder[] {
  const out: Reminder[] = [];
  for (const task of tasks) {
    if (!task.due_at) continue;
    const due = Date.parse(task.due_at);
    const created = Date.parse(task.created_at.replace(" ", "T") + "Z");
    const moments = [["day-before", due - 24 * HOUR], ["due", due]] as const;
    for (const [kind, at] of moments) {
      const key = `${task.uuid}|${task.due_at}|${kind}`;
      if (sent.has(key) || created >= at || now < at || now >= at + GRACE_MS) continue;
      out.push({ key, kind, task });
    }
  }
  return out;
}

/** The notification's body: "Due tomorrow at 15:00", or "Due now". */
export function reminderBody(r: Reminder): string {
  if (r.kind === "due") return "Due now";
  const time = new Date(r.task.due_at!).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `Due tomorrow at ${time}`;
}

/** Tomorrow at 09:00 local, the "tomorrow" snooze. */
export function tomorrowMorning(now = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9);
}
