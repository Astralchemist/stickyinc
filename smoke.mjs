#!/usr/bin/env node
// StickyInc MCP smoke test: drives the server over stdio JSON-RPC and checks
// each reply. Exits non-zero if any check fails.
//
// Usage: node smoke.mjs [server.mjs]
// With a path, runs that file with plain `node` — e.g. the bundled server
// copied somewhere with no node_modules, the way the pane ships it. Without
// one, runs src/index.ts via tsx.
//
// The server always gets a throwaway HOME, so this never touches your real
// ~/.stickyinc/tasks.db, and an llm.json pointing at a closed port, so
// add_task_natural fails fast and the same way everywhere.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "package.json"), "utf8"));
const home = mkdtempSync(join(tmpdir(), "stickyinc-smoke-"));
mkdirSync(join(home, ".stickyinc"));
writeFileSync(
  join(home, ".stickyinc", "llm.json"),
  JSON.stringify({ provider: "compat", base_url: "http://127.0.0.1:9/v1", model: "none", api_key: "none" })
);

const serverPath = process.argv[2];
const [cmd, args] = serverPath
  ? [process.execPath, [serverPath]]
  : [join(import.meta.dirname, "node_modules", ".bin", "tsx"), [join(import.meta.dirname, "src", "index.ts")]];
const child = spawn(cmd, args, {
  env: { ...process.env, HOME: home, USERPROFILE: home },
  stdio: ["pipe", "pipe", "inherit"],
});

const rl = createInterface({ input: child.stdout });
const pending = new Map();
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    console.error("[non-json]", line);
    return;
  }
  if (msg.id != null && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});

let nextId = 1;
function send(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

const failures = [];
function check(label, ok, detail) {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? `\n    ${detail.replace(/\n/g, "\n    ")}` : ""}`);
  if (!ok) failures.push(label);
}

/** Call a tool and check whether it errored as expected, and its text. */
async function tool(label, name, args, { error = false, includes } = {}) {
  const resp = await send("tools/call", { name, arguments: args });
  const text = resp.result?.content?.[0]?.text ?? JSON.stringify(resp.error ?? resp.result);
  const isError = Boolean(resp.result?.isError || resp.error);
  const ok = isError === error && (!includes || includes.every((s) => text.includes(s)));
  check(label, ok, text);
}

try {
  const init = await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "1" },
  });
  const version = init.result?.serverInfo?.version;
  check(`reports version ${pkg.version}`, version === pkg.version, `serverInfo.version = ${version}`);
  notify("notifications/initialized");

  await tool("add_task with UTC due", "add_task",
    { text: "Try the smoke test", due_at: "2026-04-24T15:00:00Z" },
    { includes: ["#1", "(2026-04-24T15:00:00Z)"] });
  await tool("add_task rejects a non-date due", "add_task",
    { text: "Bad due", due_at: "next-ish week" }, { error: true });
  await tool("add_task_natural fails cleanly with no reachable LLM", "add_task_natural",
    { input: "buy bread tomorrow at 9am" }, { error: true, includes: ["Could not parse"] });
  await tool("add_task plain", "add_task", { text: "Call the dentist" }, { includes: ["#2"] });
  // The watcher often adds a task before Claude's own add_task call lands.
  await tool("add_task skips an identical open task", "add_task", { text: "call the  Dentist" },
    { includes: ["Already on the list as #2", "Not added again"] });
  await tool("schedule_event", "schedule_event",
    { title: "Design review", start: "2026-04-23T10:00:00Z", end: "2026-04-23T11:00:00Z" },
    { includes: ["#3", "(2026-04-23T10:00:00Z)"] });
  // Same TZ as the server, so this is the date it should work out.
  const now = new Date();
  const tomorrow9 = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9)
    .toISOString().replace(/\.\d{3}Z$/, "Z");
  await tool("add_task reads 'tomorrow' as 09:00 local", "add_task",
    { text: "Buy bread", due_at: "tomorrow" },
    { includes: ["#4", `(${tomorrow9}) from "tomorrow"`] });
  await tool("list_tasks (open)", "list_tasks", {}, { includes: ["#1", "#2", "#3", "#4"] });
  await tool("complete_task #1", "complete_task", { id: 1 }, { includes: ["Completed #1"] });
  await tool("complete_task #1 again is an error", "complete_task", { id: 1 },
    { error: true, includes: ["already completed"] });
  await tool("complete_task #999 is an error", "complete_task", { id: 999 },
    { error: true, includes: ["No task"] });
  await tool("list_tasks (include_completed)", "list_tasks", { include_completed: true },
    { includes: ["[x] #1", "Done today: 1"] });
  await tool("list_done", "list_done", {}, { includes: ["#1 Try the smoke test"] });
  await tool("sticky_search finds a task by a word in it", "sticky_search", { query: "dentist" },
    { includes: ["1 task matching", "#2 Call the dentist", "added"] });
  await tool("sticky_search matches word prefixes, done tasks too", "sticky_search",
    { query: "smok", status: "done" }, { includes: ["[x] #1 Try the smoke test"] });
  await tool("sticky_search leaves out done tasks when asked for open ones", "sticky_search",
    { query: "smoke", status: "open" }, { includes: ["No tasks matching"] });
  await tool("sticky_search survives punctuation and quotes", "sticky_search",
    { query: 'Design: "review"!' }, { includes: ["#3 Design review"] });
  await tool("sticky_search since tomorrow finds nothing added today", "sticky_search",
    { since: "tomorrow" }, { includes: ["No tasks added since tomorrow"] });
  await tool("sticky_search rejects a since that isn't a date", "sticky_search",
    { since: "whenever" }, { error: true });

  const listed = (await send("prompts/list", {})).result?.prompts?.map((p) => p.name).sort() ?? [];
  check("prompts/list offers the canned prompts",
    listed.join(",") === "morning_review,overdue,weekly_closeout", listed.join(", "));
  /** Get a prompt and check its message; the built-in ones also end asking for an action list. */
  async function prompt(label, name, includes, { actionList = true } = {}) {
    const resp = await send("prompts/get", { name });
    const text = resp.result?.messages?.[0]?.content?.text ?? JSON.stringify(resp.error);
    const missing = [...includes, ...(actionList ? ["**Action list**"] : [])].filter((s) => !text.includes(s));
    check(label, missing.length === 0, missing.length ? `missing ${missing.join(" | ")}\n${text}` : text.split("\n")[0]);
  }
  await prompt("morning_review sorts the list", "morning_review",
    ["## Overdue (1)", "#3 Design review", "#4 Buy bread", "## No due date (oldest first) (1)", "#2 Call the dentist"]);
  await prompt("overdue lists what's past due", "overdue", ["## Overdue (1)", "#3 Design review"]);
  await prompt("weekly_closeout includes the week's done tasks", "weekly_closeout",
    ["## Done in the last 7 days (1)", "[x] #1 Try the smoke test", "## Added this week and still open (3)"]);

  // Routines: saved prompts, each also offered as an MCP prompt under its name.
  await tool("sticky_routine_save adds a routine", "sticky_routine_save",
    { name: "Waiting on others", prompt: "What am I waiting on from other people?", schedule: "Fridays at 3pm" },
    { includes: ['Saved routine "waiting_on_others"', "/mcp__stickyinc__waiting_on_others"] });
  await tool("sticky_routine_save refuses a built-in prompt's name", "sticky_routine_save",
    { name: "Morning review", prompt: "x" }, { error: true, includes: ["built-in"] });
  const promptNames = async () => (await send("prompts/list", {})).result?.prompts?.map((p) => p.name) ?? [];
  const afterSave = await promptNames();
  check("a saved routine is offered as a prompt", afterSave.includes("waiting_on_others"), afterSave.join(", "));
  await prompt("the routine's prompt is its text", "waiting_on_others",
    ["What am I waiting on from other people?", 'routine "waiting_on_others"', "sticky_search"], { actionList: false });
  await tool("sticky_routine_list exports JSON", "sticky_routine_list", { format: "json" },
    { includes: ['"name": "waiting_on_others"', '"schedule": "Fridays at 3pm"'] });
  await tool("sticky_routine_import takes the repo's example", "sticky_routine_import",
    { json: readFileSync(join(import.meta.dirname, "routines", "sunday-plan.json"), "utf8") },
    { includes: ["Imported sunday_plan (1 new)"] });
  await tool("sticky_routine_import rejects a bad file whole", "sticky_routine_import",
    { json: '[{"name":"ok","prompt":"x"},{"name":"broken"}]' }, { error: true, includes: ["Nothing imported"] });
  await tool("sticky_routine_list lists them", "sticky_routine_list", {},
    { includes: ["2 routines", "sunday_plan (Sundays at 7pm)", "waiting_on_others (Fridays at 3pm)"] });
  await tool("sticky_routine_delete removes one", "sticky_routine_delete", { name: "waiting on others" },
    { includes: ['Deleted routine "waiting_on_others"'] });
  const afterDelete = await promptNames();
  check("a deleted routine's prompt goes away", !afterDelete.includes("waiting_on_others") && afterDelete.includes("sunday_plan"),
    afterDelete.join(", "));
} finally {
  child.kill();
  rmSync(home, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n✗ smoke test failed: ${failures.length} check(s)`);
  process.exit(1);
}
console.log("\n✓ smoke test passed");
