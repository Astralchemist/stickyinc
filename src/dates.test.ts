// Due-date parsing against a fixed "now", in a fixed time zone, so every
// expected value is exact. Run: pnpm test
process.env.TZ = "America/Toronto"; // EDT (UTC-4) until Nov 1, 2026, then EST

import assert from "node:assert/strict";
import { test } from "node:test";
import { describeDue, resolveDue } from "./dates.js";

/** Friday 2026-09-25, 10:30 in Toronto. */
const FRI_1030 = new Date("2026-09-25T14:30:00Z");

function at(phrase: string, ref = FRI_1030): string | null {
  return resolveDue(phrase, ref).at;
}

test("a day with no time of day means 09:00 local", () => {
  assert.equal(at("tomorrow"), "2026-09-26T13:00:00Z");
  assert.equal(at("Monday"), "2026-09-28T13:00:00Z");
  assert.equal(at("next Friday"), "2026-10-02T13:00:00Z");
  assert.equal(at("in 3 days"), "2026-09-28T13:00:00Z");
  assert.equal(at("next week"), "2026-10-02T13:00:00Z");
  assert.equal(at("Oct 5"), "2026-10-05T13:00:00Z");
});

test("today, once 09:00 has passed, means the end of today", () => {
  assert.equal(at("today"), "2026-09-26T03:59:00Z"); // 23:59 local
  assert.equal(at("Friday"), "2026-09-26T03:59:00Z"); // it's Friday
  assert.equal(at("today", new Date("2026-09-25T12:00:00Z")), "2026-09-25T13:00:00Z"); // 08:00: 09:00 still ahead
});

test("explicit times are kept, and roll forward once they've passed", () => {
  assert.equal(at("friday 3pm"), "2026-09-25T19:00:00Z");
  assert.equal(at("Friday 9am"), "2026-10-02T13:00:00Z");
  assert.equal(at("9am"), "2026-09-26T13:00:00Z");
  assert.equal(at("in 2 hours"), "2026-09-25T16:30:00Z");
});

test("part-of-day words keep their own time", () => {
  assert.equal(at("tonight"), "2026-09-26T02:00:00Z"); // 22:00 local
  assert.equal(at("tomorrow afternoon"), "2026-09-26T19:00:00Z"); // 15:00 local
});

test("local time is taken on the target day, across a DST change", () => {
  // Saturday before clocks go back: tomorrow 09:00 is EST (UTC-5).
  assert.equal(at("tomorrow", new Date("2026-10-31T14:00:00Z")), "2026-11-01T14:00:00Z");
});

test("ISO 8601 is read exactly", () => {
  assert.equal(at("2026-04-24T15:00:00Z"), "2026-04-24T15:00:00Z");
  assert.equal(at("2026-04-24T15:00"), "2026-04-24T19:00:00Z");
  assert.equal(at("2026-04-24"), "2026-04-24T13:00:00Z");
});

test("words that aren't a date give no date, but keep the phrase", () => {
  for (const phrase of ["whenever", "next-ish week", "EOD"]) {
    assert.deepEqual(resolveDue(phrase, FRI_1030), {
      at: null,
      phrase,
      ref: "2026-09-25T14:30:00Z",
    });
  }
});

test("the phrase and the moment it was read against are recorded", () => {
  assert.deepEqual(resolveDue("  tomorrow ", FRI_1030), {
    at: "2026-09-26T13:00:00Z",
    phrase: "tomorrow",
    ref: "2026-09-25T14:30:00Z",
  });
});

test("describeDue leads with local time", () => {
  assert.equal(
    describeDue(resolveDue("tomorrow", FRI_1030)),
    'due Sat, Sep 26, 09:00 EDT (2026-09-26T13:00:00Z) from "tomorrow"'
  );
  assert.equal(
    describeDue(resolveDue("2026-09-26T13:00:00Z", FRI_1030)),
    "due Sat, Sep 26, 09:00 EDT (2026-09-26T13:00:00Z)"
  );
  assert.equal(
    describeDue(resolveDue("EOD", FRI_1030)),
    `couldn't read "EOD" as a date, so no due date`
  );
});
