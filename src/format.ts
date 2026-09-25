import { describeDue } from "./dates.js";
import type { Task } from "./types.js";

/** SQLite's datetime('now') (UTC, no zone) as epoch ms. */
export function sqliteUtcMs(s: string): number {
  return Date.parse(s.replace(" ", "T") + "Z");
}

/** SQLite's datetime('now') as local "Thu, Sep 4". */
export function addedOn(sqliteUtc: string): string {
  return new Date(sqliteUtcMs(sqliteUtc)).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/** "3 weeks ago": how long ago in words, so Claude can say it the same way. */
export function ago(sqliteUtc: string, now = Date.now()): string {
  const days = Math.floor((now - sqliteUtcMs(sqliteUtc)) / 86_400_000);
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  return `${Math.round(days / 30)} months ago`;
}

/**
 * A task as sticky_search and the prompts show it: status, when it was
 * added and from where, when it's due (local time first), and the words it
 * came from.
 */
export function describeTask(t: Task, now = Date.now()): string {
  const mark = t.completed_at ? "[x]" : "[ ]";
  const from = t.source_client ? ` from ${t.source_client}` : "";
  const due = t.due_at
    ? ` — ${describeDue({ at: t.due_at, phrase: t.due_phrase ?? t.due_at, ref: "" })}`
    : "";
  const line = `${mark} #${t.id} ${t.text} — added ${addedOn(t.created_at)} (${ago(t.created_at, now)})${from}${due}`;
  return t.source_excerpt ? `${line}\n    “${t.source_excerpt}”` : line;
}
