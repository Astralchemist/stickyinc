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
    { includes: ["#1", "due 2026-04-24T15:00:00Z"] });
  await tool("add_task rejects a non-date due", "add_task",
    { text: "Bad due", due_at: "next-ish week" }, { error: true });
  await tool("add_task_natural fails cleanly with no reachable LLM", "add_task_natural",
    { input: "buy bread tomorrow at 9am" }, { error: true, includes: ["Could not parse"] });
  await tool("add_task plain", "add_task", { text: "Call the dentist" }, { includes: ["#2"] });
  await tool("schedule_event", "schedule_event",
    { title: "Design review", start: "2026-04-23T10:00:00Z", end: "2026-04-23T11:00:00Z" },
    { includes: ["#3", "2026-04-23T10:00:00Z"] });
  await tool("list_tasks (open)", "list_tasks", {}, { includes: ["#1", "#2", "#3"] });
  await tool("complete_task #1", "complete_task", { id: 1 }, { includes: ["Completed #1"] });
  await tool("complete_task #1 again is an error", "complete_task", { id: 1 },
    { error: true, includes: ["already completed"] });
  await tool("complete_task #999 is an error", "complete_task", { id: 999 },
    { error: true, includes: ["No task"] });
  await tool("list_tasks (include_completed)", "list_tasks", { include_completed: true },
    { includes: ["[x] #1", "Done today: 1"] });
  await tool("list_done", "list_done", {}, { includes: ["#1 Try the smoke test"] });
} finally {
  child.kill();
  rmSync(home, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n✗ smoke test failed: ${failures.length} check(s)`);
  process.exit(1);
}
console.log("\n✓ smoke test passed");
