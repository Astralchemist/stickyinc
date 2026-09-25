import assert from "node:assert/strict";
import { test } from "node:test";
import { ftsQuery, likeAnywhere, searchWords, toSqliteUtc } from "./search.js";

test("search words drop punctuation that would break the query syntax", () => {
  assert.deepEqual(searchWords('Design: "review" e-mail (Sarah)*'), ["Design", "review", "e", "mail", "Sarah"]);
  assert.deepEqual(searchWords("café naïve 2026"), ["café", "naïve", "2026"]);
  assert.deepEqual(searchWords(" \"\" --- "), []);
});

test("each word matches as a prefix", () => {
  assert.equal(ftsQuery(["call", "dent"]), '"call"* "dent"*');
});

test("since compares in created_at's own shape", () => {
  assert.equal(toSqliteUtc("2026-09-04T04:00:00Z"), "2026-09-04 04:00:00");
  assert.equal(toSqliteUtc("2026-09-04T04:00:00.123Z"), "2026-09-04 04:00:00");
});

test("LIKE wildcards in a word are matched literally", () => {
  assert.equal(likeAnywhere("50%_off"), "%50\\%\\_off%");
});
