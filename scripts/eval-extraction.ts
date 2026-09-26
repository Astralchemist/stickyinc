// Score the passive watcher's extraction against labelled messages in
// evals/extraction/cases.json: how many tasks it makes that shouldn't exist
// (garbage), how many real ones it finds, whether due dates and quotes are
// right, and how long each call takes. Calls the configured LLM, so it costs
// a little and isn't part of `pnpm test`.
//
//   pnpm eval:extraction                     # the provider the watcher would use
//   pnpm eval:extraction --model <id>        # same provider, another model
//   pnpm eval:extraction --provider claude-code [--model haiku]
//   pnpm eval:extraction --save              # write evals/extraction/results/
//   pnpm eval:extraction --only c0           # cases whose id starts with c0
//
// Exits 1 if garbage is above --max-garbage (0.05) or found is below
// --min-found (0.85).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { providerFromConfig, readConfigFile, resolveLLMProvider, type LLMConfig } from "../src/providers/index.js";

const { values: flags } = parseArgs({
  options: {
    provider: { type: "string" },
    model: { type: "string" },
    only: { type: "string" },
    save: { type: "boolean", default: false },
    concurrency: { type: "string", default: "4" },
    "max-garbage": { type: "string", default: "0.05" },
    "min-found": { type: "string", default: "0.85" },
  },
});

// Dates are read in UTC so expected due times don't depend on this machine,
// and the watcher module opens a database on import, so point it at a
// throwaway one before loading it.
process.env.TZ = "UTC";
const scratch = mkdtempSync(join(tmpdir(), "stickyinc-eval-"));
process.env.STICKYINC_DB = join(scratch, "tasks.db");
const { extract } = await import("../src/watcher.js");

type Commitment = Awaited<ReturnType<typeof extract>>[number];
interface Expected {
  match: string[];
  due?: null | { on: string } | { at: string };
}
interface Case {
  id: string;
  category: string;
  speaker?: "user" | "assistant";
  message: string;
  pad?: number;
  expect: Expected[];
}

const root = join(import.meta.dirname, "..", "evals", "extraction");
const file = JSON.parse(readFileSync(join(root, "cases.json"), "utf8")) as { said: string; cases: Case[] };
const said = new Date(file.said);
const cases = file.cases.filter((c) => !flags.only || c.id.startsWith(flags.only));

const provider = await (async () => {
  if (!flags.provider && !flags.model) return resolveLLMProvider();
  const cfg = readConfigFile();
  if (flags.provider) return providerFromConfig({ ...(cfg?.provider === flags.provider ? cfg : {}), provider: flags.provider as LLMConfig["provider"], model: flags.model });
  if (!cfg) throw new Error("--model without --provider needs a provider in ~/.stickyinc/llm.json");
  return providerFromConfig({ ...cfg, model: flags.model });
})();
if (!provider) {
  console.error("No LLM configured; see README 'LLM providers'.");
  process.exit(1);
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
const matches = (task: string, e: Expected) =>
  e.match.every((word) => word.split("|").some((alt) => norm(task).includes(alt)));

function dueOk(c: Commitment, e: Expected): boolean | undefined {
  if (!("due" in e)) return undefined;
  const at = c.due?.at ?? null;
  if (e.due === null || e.due === undefined) return at === null;
  if ("on" in e.due) return at?.slice(0, 10) === e.due.on;
  return at?.slice(0, 16) === e.due.at;
}

/** Lines of a deploy log, to push a message past the watcher's 4000-character cut. */
function padding(chars: number): string {
  let out = "";
  for (let i = 0; out.length < chars; i++) {
    out += `12:04:${String(i % 60).padStart(2, "0")}.${i} [build] Compiled chunk ${i} (${(i * 37) % 900} kB) ok\n`;
  }
  return out;
}

interface Result {
  id: string;
  category: string;
  message: string;
  ms: number;
  error?: string;
  got: { text: string; due: string | null; duePhrase: string | null; quote: string | null; quoteExact: boolean }[];
  found: number;
  missed: string[];
  garbage: string[];
  dueChecked: number;
  dueWrong: string[];
}

async function run(c: Case): Promise<Result> {
  const text = c.pad ? padding(c.pad) + c.message : c.message;
  const start = performance.now();
  let got: Commitment[] = [];
  let error: string | undefined;
  try {
    got = await extract(provider!, c.speaker ?? "user", text, said);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const ms = performance.now() - start;

  // Each expected task takes the first unclaimed extraction that matches it;
  // whatever's left over is garbage, duplicates included.
  const claimed = new Set<number>();
  const missed: string[] = [];
  const dueWrong: string[] = [];
  let dueChecked = 0;
  for (const e of c.expect) {
    const i = got.findIndex((g, j) => !claimed.has(j) && matches(g.text, e));
    if (i < 0) {
      missed.push(e.match.join(" + "));
      continue;
    }
    claimed.add(i);
    const ok = dueOk(got[i], e);
    if (ok === undefined) continue;
    dueChecked++;
    if (!ok) dueWrong.push(`"${got[i].text}" due ${got[i].due?.at ?? "none"} (from "${got[i].due?.phrase ?? ""}"), wanted ${JSON.stringify(e.due)}`);
  }
  return {
    id: c.id,
    category: c.category,
    message: c.message,
    ms,
    error,
    got: got.map((g) => ({
      text: g.text,
      due: g.due?.at ?? null,
      duePhrase: g.due?.phrase ?? null,
      quote: g.quote,
      quoteExact: !!g.quote && norm(text).includes(norm(g.quote)),
    })),
    found: c.expect.length - missed.length,
    missed,
    garbage: got.filter((_, j) => !claimed.has(j)).map((g) => g.text),
    dueChecked,
    dueWrong,
  };
}

// A small pool: CLI providers take seconds per call.
const results: Result[] = new Array(cases.length);
let next = 0;
await Promise.all(
  Array.from({ length: Math.max(1, Number(flags.concurrency)) }, async () => {
    while (next < cases.length) {
      const i = next++;
      results[i] = await run(cases[i]);
      process.stderr.write(".");
    }
  }),
);
process.stderr.write("\n");
rmSync(scratch, { recursive: true, force: true });

const sum = (f: (r: Result) => number, rs = results) => rs.reduce((n, r) => n + f(r), 0);
const extracted = sum((r) => r.got.length);
const expected = sum((r) => r.found + r.missed.length);
const found = sum((r) => r.found);
const garbage = sum((r) => r.garbage.length);
const dueChecked = sum((r) => r.dueChecked);
const dueWrong = sum((r) => r.dueWrong.length);
const quoted = results.flatMap((r) => r.got).filter((g) => g.quote);
const errors = results.filter((r) => r.error);
const ms = results.map((r) => r.ms).sort((a, b) => a - b);
const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : "n/a");
const at = (q: number) => ms[Math.min(ms.length - 1, Math.floor(q * ms.length))];

const metrics = {
  garbageRate: extracted ? garbage / extracted : 0,
  foundRate: expected ? found / expected : 1,
  dueAccuracy: dueChecked ? (dueChecked - dueWrong) / dueChecked : 1,
  quoteExactRate: quoted.length ? quoted.filter((g) => g.quoteExact).length / quoted.length : 1,
  latencyP50Ms: Math.round(at(0.5)),
  latencyP95Ms: Math.round(at(0.95)),
};

console.log(`\n${provider.name} · ${provider.model} · ${results.length} messages, ${expected} real tasks\n`);
console.log(`  garbage     ${pct(garbage, extracted).padStart(6)}   ${garbage} of ${extracted} tasks made shouldn't exist`);
console.log(`  found       ${pct(found, expected).padStart(6)}   ${found} of ${expected} real tasks`);
console.log(`  due dates   ${pct(dueChecked - dueWrong, dueChecked).padStart(6)}   ${dueChecked - dueWrong} of ${dueChecked} right`);
console.log(`  quotes      ${pct(quoted.filter((g) => g.quoteExact).length, quoted.length).padStart(6)}   exact quotes from the message`);
console.log(`  latency     p50 ${metrics.latencyP50Ms} ms · p95 ${metrics.latencyP95Ms} ms per message`);
const errorCounts = new Map<string, number>();
for (const r of errors) errorCounts.set(r.error!, (errorCounts.get(r.error!) ?? 0) + 1);
for (const [message, n] of errorCounts) console.log(`  errors      ${n} calls failed: ${message.slice(0, 160)}`);

console.log("\n  by category                 tasks  found  garbage");
for (const category of [...new Set(results.map((r) => r.category))]) {
  const rs = results.filter((r) => r.category === category);
  const exp = sum((r) => r.found + r.missed.length, rs);
  console.log(
    `  ${category.padEnd(26)} ${String(exp).padStart(6)} ${String(sum((r) => r.found, rs)).padStart(6)} ${String(sum((r) => r.garbage.length, rs)).padStart(8)}`,
  );
}

const failures = results.filter((r) => r.error || r.missed.length || r.garbage.length || r.dueWrong.length);
if (failures.length) {
  console.log("\n  what went wrong");
  for (const r of failures) {
    console.log(`  ${r.id}  ${r.message.replace(/\s+/g, " ").slice(0, 90)}`);
    if (r.error) {
      console.log("        call failed (see errors above)");
      continue;
    }
    for (const m of r.missed) console.log(`        missed: ${m}`);
    for (const g of r.garbage) console.log(`        garbage: "${g}"`);
    for (const d of r.dueWrong) console.log(`        due: ${d}`);
  }
}

if (flags.save && errors.length) console.log("\n  not saved: some calls failed");
else if (flags.save) {
  const dir = join(root, "results");
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `${provider.name}--${provider.model.replace(/[^\w.-]+/g, "_")}.json`);
  writeFileSync(out, JSON.stringify({ provider: provider.name, model: provider.model, ranAt: new Date().toISOString(), said: file.said, metrics, results }, null, 2) + "\n");
  console.log(`\n  saved ${out}`);
}

const maxGarbage = Number(flags["max-garbage"]);
const minFound = Number(flags["min-found"]);
const pass = metrics.garbageRate <= maxGarbage && metrics.foundRate >= minFound && !errors.length;
console.log(`\n  ${pass ? "PASS" : "FAIL"}: garbage ≤ ${pct(maxGarbage, 1)}, found ≥ ${pct(minFound, 1)}${errors.length ? ", no failed calls" : ""}`);
process.exit(pass ? 0 : 1);
