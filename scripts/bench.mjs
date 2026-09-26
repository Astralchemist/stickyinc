// A latency budget for the bundled MCP server: start it, time `initialize`
// and each tool against a throwaway database seeded with 5,000 tasks, and
// exit 1 if anything is over budget. Each tool's first call is timed on its
// own, since that's where one-off costs like loading the date parser land.
// The budgets sit several times above what a laptop measures, so they catch
// a real regression (a network call, a query that scans too much) rather
// than a busy machine.
//
//   node scripts/bench.mjs dist/bundle/stickyinc-mcp.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";

const SEEDED = 5000;
const REPS = 30;
/** Milliseconds. Measured on an M-series Mac: ~120, then ≤ 6 per tool, ~30 for search. */
const BUDGET = { startup: 500, tool: 25, search: 150, firstCall: 250 };

const bundle = process.argv[2];
if (!bundle) {
  console.error("usage: node scripts/bench.mjs <path to stickyinc-mcp.mjs>");
  process.exit(2);
}
const home = mkdtempSync(join(tmpdir(), "stickyinc-bench-"));
const db = join(home, "tasks.db");

/** Start the server, run `body` against it, stop it. Resolves to how long `initialize` took. */
async function withServer(body) {
  const start = performance.now();
  const child = spawn(process.execPath, [bundle], {
    env: { ...process.env, HOME: home, STICKYINC_DB: db },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const pending = new Map();
  let id = 0;
  createInterface({ input: child.stdout }).on("line", (line) => {
    const msg = JSON.parse(line);
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  });
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, (m) => (m.error || m.result?.isError ? reject(new Error(JSON.stringify(m.error ?? m.result.content))) : resolve(m.result)));
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
    });
  try {
    await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bench", version: "0" } });
    const startup = performance.now() - start;
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    await body(call);
    return startup;
  } finally {
    child.kill();
  }
}

// The server makes the schema; then fill it the way months of use would.
await withServer(async () => {});
const seed = new DatabaseSync(db);
seed.exec("BEGIN");
const insert = seed.prepare("INSERT INTO tasks (uuid, text, created_at, completed_at) VALUES (?, ?, datetime('now'), ?)");
for (let i = 0; i < SEEDED; i++) {
  insert.run(crypto.randomUUID(), `Seeded task ${i} about invoices, the dentist and report ${i % 97}`, i % 5 === 0 ? null : "2026-01-01 00:00:00");
}
seed.exec("COMMIT");
seed.close();

const rows = [];
let firstCall = { label: "", ms: 0 };
const startup = await withServer(async (call) => {
  const time = async (label, budget, name, args) => {
    const t0 = performance.now();
    await call("tools/call", { name, arguments: args(-1) });
    const first = performance.now() - t0;
    if (first > firstCall.ms) firstCall = { label, ms: first };
    const ms = [];
    for (let i = 0; i < REPS; i++) {
      const t = performance.now();
      await call("tools/call", { name, arguments: args(i) });
      ms.push(performance.now() - t);
    }
    ms.sort((a, b) => a - b);
    rows.push({ label, budget, p50: ms[Math.floor(REPS / 2)], p95: ms[Math.floor(REPS * 0.95)] });
  };
  await time("list_tasks", BUDGET.tool, "list_tasks", () => ({}));
  await time("add_task", BUDGET.tool, "add_task", (i) => ({ text: `bench task ${i}` }));
  await time("add_task with due words", BUDGET.tool, "add_task", (i) => ({ text: `bench due ${i}`, due_at: "tomorrow at 3pm" }));
  // Tasks SEEDED+1 onward are the ones just added; each is ticked off once.
  await time("complete_task", BUDGET.tool, "complete_task", (i) => ({ id: SEEDED + 2 + i }));
  await time("sticky_search", BUDGET.search, "sticky_search", () => ({ query: "dentist invoices" }));
});
rmSync(home, { recursive: true, force: true });

rows.unshift({ label: "startup to initialize", budget: BUDGET.startup, p50: startup, p95: startup });
rows.push({ label: `slowest first call`, budget: BUDGET.firstCall, p50: firstCall.ms, p95: firstCall.ms, note: firstCall.label });
console.log(`MCP server latency, ${SEEDED} tasks (p50 / p95 / budget, ms):`);
let over = 0;
for (const r of rows) {
  const ok = r.p95 <= r.budget;
  if (!ok) over++;
  console.log(`${ok ? "✓" : "✗"} ${r.label.padEnd(24)} ${r.p50.toFixed(1).padStart(7)} ${r.p95.toFixed(1).padStart(7)} ${String(r.budget).padStart(6)}${r.note ? `  (${r.note})` : ""}`);
}
if (over) {
  console.error(`\n✗ ${over} over budget`);
  process.exit(1);
}
console.log("\n✓ latency within budget");
