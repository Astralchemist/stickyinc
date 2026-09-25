import { describeDue } from "../dates.js";
import type { Task } from "../types.js";

/**
 * The reply when an identical open task already exists, usually because the
 * passive watcher heard the same sentence before Claude called the tool, so
 * Claude tells the user it's there rather than that it was added.
 */
export function alreadyListed(task: Task): string {
  const due = task.due_at
    ? `, ${describeDue({ at: task.due_at, phrase: task.due_phrase ?? task.due_at, ref: "" })}`
    : "";
  return `Already on the list as #${task.id}: ${task.text}${due}. Not added again.`;
}
