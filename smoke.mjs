#!/usr/bin/env node
// Sequential JSON-RPC client over stdio for StickyInc MCP smoke test.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const child = spawn("pnpm", ["-s", "dev"], {
  cwd: import.meta.dirname,
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

function show(label, resp) {
  const content = resp.result?.content?.[0]?.text ?? JSON.stringify(resp.result ?? resp.error);
  console.log(`\n▸ ${label}\n${content}`);
}

try {
  const init = await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "1" },
  });
  console.log("▸ initialize →", init.result?.serverInfo);
  notify("notifications/initialized");

  show("add_task (with due)", await send("tools/call", {
    name: "add_task",
    arguments: { text: "Try the smoke test", due_at: "2026-04-24T15:00:00Z" },
  }));

  // add_task_natural: verifies graceful fallback when no LLM is configured,
  // or performs a real parse if a key is present.
  show("add_task_natural", await send("tools/call", {
    name: "add_task_natural",
    arguments: { input: "buy bread tomorrow at 9am" },
  }));

  show("add_task (plain)", await send("tools/call", {
    name: "add_task",
    arguments: { text: "Call the dentist" },
  }));

  show("schedule_event (local only)", await send("tools/call", {
    name: "schedule_event",
    arguments: { title: "Design review", start: "2026-04-23T10:00:00Z", end: "2026-04-23T11:00:00Z" },
  }));

  show("list_tasks (open)", await send("tools/call", {
    name: "list_tasks",
    arguments: {},
  }));

  show("complete_task #1", await send("tools/call", {
    name: "complete_task",
    arguments: { id: 1 },
  }));

  show("complete_task #1 again (should error)", await send("tools/call", {
    name: "complete_task",
    arguments: { id: 1 },
  }));

  show("complete_task #999 (should error)", await send("tools/call", {
    name: "complete_task",
    arguments: { id: 999 },
  }));

  show("list_tasks (all, include_completed)", await send("tools/call", {
    name: "list_tasks",
    arguments: { include_completed: true },
  }));

  show("list_done (default 24h)", await send("tools/call", {
    name: "list_done",
    arguments: {},
  }));

  show("list_done (with archive)", await send("tools/call", {
    name: "list_done",
    arguments: { hours: 1, include_archive: true },
  }));

  console.log("\n✓ smoke test passed");
} finally {
  child.kill();
}
