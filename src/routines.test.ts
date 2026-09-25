import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { checkRoutine, exportRoutines, parseRoutines, routineName } from "./routines.js";

test("routine names become prompt names", () => {
  assert.equal(routineName("Waiting on others"), "waiting_on_others");
  assert.equal(routineName("  Café — Friday check! "), "cafe_friday_check");
  assert.equal(routineName("x".repeat(60))!.length, 40);
  assert.equal(routineName("!!!"), null);
});

test("a routine needs a free name and a prompt", () => {
  assert.deepEqual(checkRoutine({ name: "Sunday plan", prompt: " Plan my week " }), {
    routine: { name: "sunday_plan", prompt: "Plan my week", schedule: null },
  });
  assert.match((checkRoutine({ name: "Morning review", prompt: "x" }) as { error: string }).error, /built-in/);
  assert.match((checkRoutine({ name: "a", prompt: "  " }) as { error: string }).error, /needs a prompt/);
  assert.match((checkRoutine({ name: "a", prompt: "x".repeat(4001) }) as { error: string }).error, /over 4000/);
  assert.match((checkRoutine({ name: "a", prompt: "x", schedule: 5 }) as { error: string }).error, /schedule/);
});

test("import takes one routine or a list, all or nothing", () => {
  assert.equal((parseRoutines('{"name":"a","prompt":"x"}') as { routines: unknown[] }).routines.length, 1);
  const bad = parseRoutines('[{"name":"a","prompt":"x"},{"name":"b"}]');
  assert.match((bad as { error: string }).error, /routine 2: "b" needs a prompt/);
  assert.match((parseRoutines('[{"name":"a","prompt":"x"},{"name":"A","prompt":"y"}]') as { error: string }).error, /"a" appears twice/);
  assert.match((parseRoutines("not json") as { error: string }).error, /isn't JSON/);
  assert.match((parseRoutines("[]") as { error: string }).error, /no routines/);
});

test("export and import round-trip", () => {
  const routines = [{ name: "a", prompt: "x", schedule: "Fridays" }, { name: "b", prompt: "y", schedule: null }];
  assert.deepEqual((parseRoutines(exportRoutines(routines)) as { routines: unknown[] }).routines, routines);
});

test("the example routines in the repo import cleanly", () => {
  const dir = join(import.meta.dirname, "..", "routines");
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  assert.ok(files.length >= 2, "at least two examples");
  for (const f of files) {
    const parsed = parseRoutines(readFileSync(join(dir, f), "utf8"));
    assert.ok("routines" in parsed, `${f}: ${"error" in parsed ? parsed.error : ""}`);
  }
});
