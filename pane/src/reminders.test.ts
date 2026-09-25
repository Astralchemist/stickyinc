// Run with the root's `pnpm test` (tsx); excluded from the pane's tsc, which has no Node types.
process.env.TZ = "America/Toronto";

import assert from "node:assert/strict";
import { test } from "node:test";
import { remindersDue, tomorrowMorning } from "./reminders";

const H = 3_600_000;
const DUE = Date.parse("2026-10-02T19:00:00Z"); // Fri 15:00 in Toronto
const task = (created_at = "2026-09-25 12:00:00", due_at: string | null = "2026-10-02T19:00:00Z") =>
  ({ uuid: "u1", text: "Call the dentist", created_at, due_at });
const kinds = (now: number, sent = new Set<string>(), t = task()) => remindersDue([t], now, sent).map((r) => r.kind);

test("a day before, and when due", () => {
  assert.deepEqual(kinds(DUE - 24 * H - 1), []);
  assert.deepEqual(kinds(DUE - 24 * H), ["day-before"]);
  assert.deepEqual(kinds(DUE - 12 * H), []); // between the two
  assert.deepEqual(kinds(DUE + 5 * 60_000), ["due"]);
});

test("each goes out once per due time", () => {
  const [r] = remindersDue([task()], DUE, new Set());
  assert.deepEqual(kinds(DUE + 60_000, new Set([r.key])), []);
  // Snoozed: a new due time reminds again.
  const snoozed = task(undefined, "2026-10-02T20:00:00Z");
  assert.deepEqual(kinds(DUE + H, new Set([r.key]), snoozed), ["due"]);
});

test("stale reminders are dropped, and there's none for a moment before the task existed", () => {
  assert.deepEqual(kinds(DUE + 2 * H), []); // pane was closed through it
  assert.deepEqual(kinds(DUE, new Set(), task("2026-10-02 19:30:00")), []); // added after it was due
  assert.deepEqual(kinds(DUE - 24 * H, new Set(), task("2026-10-01 20:00:00")), []); // added inside the last day
  assert.deepEqual(kinds(DUE, new Set(), task(undefined, null)), []); // no due date
});

test("a snooze an hour out doesn't set off the day-before reminder", () => {
  const now = Date.parse("2026-09-30T14:00:00Z");
  const snoozed = task(undefined, new Date(now + H).toISOString());
  assert.deepEqual(kinds(now, new Set(), snoozed), []);
});

test("tomorrow's snooze is 09:00 local", () => {
  assert.equal(tomorrowMorning(new Date("2026-09-25T14:30:00Z")).toISOString(), "2026-09-26T13:00:00.000Z");
});
