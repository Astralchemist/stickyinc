/**
 * The canned MCP prompts: morning_review, overdue, weekly_closeout. Each is
 * a message with the user's tasks already in it (fetched the way
 * sticky_search fetches them, shown the way it shows them), so the model
 * starts from real data instead of a tool call, and each asks it to finish
 * with an action list. Pure: callers pass in the tasks and the time.
 */
import { describeTask, sqliteUtcMs } from "./format.js";
import type { Task } from "./types.js";

const DAY = 86_400_000;

/** How to close each prompt: concrete, numbered, tied to task numbers. */
function actionList(scope: string, max: number): string {
  return (
    `End with an **Action list**: at most ${max} concrete next steps ${scope}, most important first, ` +
    `numbered, each naming its task number, e.g. "1. Call the dentist (#12) before 10am". ` +
    `If I agree something is done or should be dropped, mark it with complete_task.`
  );
}

/** A titled list of tasks, or nothing if there are none. */
function section(title: string, tasks: Task[], now: number): string {
  if (tasks.length === 0) return "";
  return `## ${title} (${tasks.length})\n${tasks.map((t) => describeTask(t, now)).join("\n")}\n`;
}

const due = (t: Task) => (t.due_at ? Date.parse(t.due_at) : Infinity);
const byDue = (a: Task, b: Task) => due(a) - due(b);
const byAdded = (a: Task, b: Task) => sqliteUtcMs(a.created_at) - sqliteUtcMs(b.created_at);

function endOfDay(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
}

function today(now: Date): string {
  return now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

export function morningReview(open: Task[], now = new Date()): string {
  const t = now.getTime();
  const eod = endOfDay(now);
  const dated = open.filter((x) => x.due_at).sort(byDue);
  const overdue = dated.filter((x) => due(x) < t);
  const dueToday = dated.filter((x) => due(x) >= t && due(x) < eod);
  const thisWeek = dated.filter((x) => due(x) >= eod && due(x) < t + 7 * DAY);
  const undated = open.filter((x) => !x.due_at).sort(byAdded).slice(0, 10);
  const body =
    section("Overdue", overdue, t) +
    section("Due today", dueToday, t) +
    section("Due in the next 7 days", thisWeek, t) +
    section("No due date (oldest first)", undated, t);
  return [
    `Morning review for ${today(now)}. Here's what's on my StickyInc list:`,
    body || "Nothing is open.",
    "Go through it with me: what matters most today, what's slipping, and what I should reschedule or drop. " +
      "Point out anything I've been carrying for a long time.",
    actionList("for today", 5),
  ].join("\n\n");
}

export function overdueReview(open: Task[], now = new Date()): string {
  const t = now.getTime();
  const overdue = open.filter((x) => x.due_at && due(x) < t).sort(byDue);
  if (overdue.length === 0) {
    // Include what's coming up, so the model can suggest what to get
    // ahead on from the data rather than going looking for it.
    const upcoming = open.filter((x) => x.due_at && due(x) < t + 7 * DAY).sort(byDue);
    return [
      `Nothing on my StickyInc list is overdue as of ${today(now)}.`,
      section("Due in the next 7 days", upcoming, t) || "Nothing is due in the next 7 days either.",
      "Tell me I'm clear, then suggest what to get ahead on.",
      actionList("to get ahead", 3),
    ].join("\n\n");
  }
  return [
    `These StickyInc tasks are overdue as of ${today(now)}, with when I added them and the words they came from:`,
    section("Overdue", overdue, t),
    "For each one, say whether I should do it now, reschedule it (to when), or drop it, " +
      "and why, going by what I said when I added it.",
    actionList("to clear the backlog", 7),
  ].join("\n\n");
}

export function weeklyCloseout(open: Task[], doneThisWeek: Task[], now = new Date()): string {
  const t = now.getTime();
  const weekAgo = t - 7 * DAY;
  const addedThisWeek = open.filter((x) => sqliteUtcMs(x.created_at) >= weekAgo).sort(byAdded);
  const dated = open.filter((x) => x.due_at).sort(byDue);
  const overdue = dated.filter((x) => due(x) < t);
  const nextWeek = dated.filter((x) => due(x) >= t && due(x) < t + 7 * DAY);
  const body =
    section("Done in the last 7 days", doneThisWeek, t) +
    section("Added this week and still open", addedThisWeek, t) +
    section("Overdue", overdue, t) +
    section("Due in the next 7 days", nextWeek, t);
  return [
    `Weekly close-out, ${today(now)}. Here's my week in StickyInc:`,
    body || "Nothing was done or added this week, and nothing is due.",
    "Close out the week with me: what got done, what slipped and why it might have, " +
      "and what to carry into next week versus drop.",
    actionList("for next week", 7),
  ].join("\n\n");
}
