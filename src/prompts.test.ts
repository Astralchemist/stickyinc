process.env.TZ = "America/Toronto";

import assert from "node:assert/strict";
import { test } from "node:test";
import { morningReview, overdueReview, weeklyCloseout } from "./prompts.js";
import type { Task } from "./types.js";

/** Friday 2026-09-25, 10:30 in Toronto. */
const NOW = new Date("2026-09-25T14:30:00Z");

let id = 0;
function task(text: string, due: string | null, added = "2026-09-20 12:00:00", done: string | null = null): Task {
  id += 1;
  return {
    id, uuid: `u${id}`, text, created_at: added, completed_at: done, due_at: due, due_phrase: null,
    source: "claude", source_client: "Claude Code", source_ref: null, source_excerpt: null,
  };
}

const overdue = task("Pay rent", "2026-09-24T13:00:00Z");
const today = task("Call the dentist", "2026-09-25T19:00:00Z");
const nextWeek = task("Email Sarah", "2026-09-29T13:00:00Z");
const farOff = task("Renew passport", "2026-12-01T14:00:00Z");
const undatedOld = task("Fix the bike", null, "2026-08-01 12:00:00");
const undatedNew = task("Buy bread", null, "2026-09-25 12:00:00");
const open = [nextWeek, farOff, undatedNew, today, overdue, undatedOld];

function sectionOf(text: string, title: string): string {
  const start = text.indexOf(`## ${title}`);
  if (start < 0) return "";
  const end = text.indexOf("\n## ", start + 1);
  return text.slice(start, end < 0 ? text.indexOf("\n\n", start) : end);
}

test("morning review sorts tasks into overdue, today, this week and undated", () => {
  const text = morningReview(open, NOW);
  assert.match(text, /^Morning review for Friday, September 25\./);
  assert.match(sectionOf(text, "Overdue"), /#1 Pay rent/);
  assert.match(sectionOf(text, "Due today"), /#2 Call the dentist/);
  assert.match(sectionOf(text, "Due in the next 7 days"), /#3 Email Sarah/);
  assert.doesNotMatch(text, /Renew passport/); // more than a week out
  const undated = sectionOf(text, "No due date (oldest first)");
  assert.ok(undated.indexOf("Fix the bike") < undated.indexOf("Buy bread"), "oldest first");
  assert.match(text, /\*\*Action list\*\*: at most 5 concrete next steps for today/);
});

test("overdue lists only what's past due, or says there's nothing", () => {
  const text = overdueReview(open, NOW);
  assert.match(sectionOf(text, "Overdue"), /Overdue \(1\)[\s\S]*#1 Pay rent/);
  assert.match(text, /do it now, reschedule it \(to when\), or drop it/);
  assert.match(text, /\*\*Action list\*\*/);
  const clear = overdueReview([today, farOff], NOW);
  assert.match(clear, /Nothing on my StickyInc list is overdue/);
  assert.match(sectionOf(clear, "Due in the next 7 days"), /Due in the next 7 days \(1\)[\s\S]*Call the dentist/);
  assert.match(clear, /\*\*Action list\*\*: at most 3 concrete next steps to get ahead/);
});

test("weekly close-out covers done, added, overdue and next week", () => {
  const done = [task("Ship v0.5", null, "2026-09-10 12:00:00", "2026-09-23 12:00:00")];
  const text = weeklyCloseout(open, done, NOW);
  assert.match(sectionOf(text, "Done in the last 7 days"), /\[x\] #\d+ Ship v0\.5/);
  const added = sectionOf(text, "Added this week and still open");
  assert.match(added, /Buy bread/);
  assert.doesNotMatch(added, /Fix the bike/); // added in August
  assert.match(sectionOf(text, "Due in the next 7 days"), /Call the dentist[\s\S]*Email Sarah/);
  assert.match(text, /for next week/);
});

test("empty lists still make a prompt", () => {
  assert.match(morningReview([], NOW), /Nothing is open\./);
  assert.match(weeklyCloseout([], [], NOW), /Nothing was done or added this week/);
});
