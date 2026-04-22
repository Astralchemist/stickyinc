import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Task } from "./types.js";

const DATA_DIR = join(homedir(), ".stickyinc");
const DB_PATH = join(DATA_DIR, "tasks.db");

mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

// Phase 1: tables and indexes that don't depend on columns added by
// migrations below. Creating the uuid UNIQUE INDEX here would fail on
// pre-v0.6 databases where the column doesn't exist yet.
db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid TEXT,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT,
    due_at TEXT,
    source TEXT NOT NULL DEFAULT 'claude',
    fingerprint TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_completed ON tasks(completed_at);
  CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_at);

  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS task_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_uuid TEXT NOT NULL UNIQUE,
    task_uuid TEXT NOT NULL,
    op TEXT NOT NULL CHECK (op IN ('create','complete','uncomplete','edit','delete')),
    payload TEXT,
    device_id TEXT NOT NULL,
    ts TEXT NOT NULL DEFAULT (datetime('now')),
    lamport INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_uuid);
  CREATE INDEX IF NOT EXISTS idx_task_events_lamport ON task_events(device_id, lamport);
`);

// Phase 2: column-adding migrations. Idempotent; the column-existence check
// keeps them no-op on fresh DBs.
{
  const cols = db.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === "fingerprint")) {
    db.exec(`ALTER TABLE tasks ADD COLUMN fingerprint TEXT`);
  }
  if (!cols.some((c) => c.name === "uuid")) {
    db.exec(`ALTER TABLE tasks ADD COLUMN uuid TEXT`);
  }
  // Backfill uuid for any rows created before v0.6.
  const pending = db.prepare(`SELECT id FROM tasks WHERE uuid IS NULL`).all() as {
    id: number;
  }[];
  if (pending.length > 0) {
    const setUuid = db.prepare(`UPDATE tasks SET uuid = ? WHERE id = ?`);
    const txn = db.transaction(() => {
      for (const row of pending) setUuid.run(randomUUID(), row.id);
    });
    txn();
  }
}

// Phase 3: indexes on migrated columns. Safe now that the columns exist
// and every row has a value.
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_tasks_fingerprint ON tasks(fingerprint);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_uuid ON tasks(uuid);
`);

/**
 * Device id — stable, unique per machine. Generated once on first DB touch,
 * persisted in the meta table so both the Node MCP server and the Rust pane
 * see the same value. Used to stamp every task_events row.
 */
function ensureDeviceId(): string {
  const row = db
    .prepare(`SELECT value FROM meta WHERE key = 'device_id'`)
    .get() as { value: string } | undefined;
  if (row) return row.value;
  const id = randomUUID();
  db.prepare(
    `INSERT OR IGNORE INTO meta (key, value) VALUES ('device_id', ?)`
  ).run(id);
  // Race-safe re-read in case Rust got there first.
  const final = db
    .prepare(`SELECT value FROM meta WHERE key = 'device_id'`)
    .get() as { value: string };
  return final.value;
}

const DEVICE_ID = ensureDeviceId();

/**
 * Next Lamport-style counter for this device. Monotonic per device; callers
 * wrap it inside the same transaction as the mutation so there's no race.
 */
function nextLamport(): number {
  const row = db
    .prepare(`SELECT MAX(lamport) as m FROM task_events WHERE device_id = ?`)
    .get(DEVICE_ID) as { m: number | null };
  return (row.m ?? 0) + 1;
}

const insertEventStmt = db.prepare(
  `INSERT INTO task_events (event_uuid, task_uuid, op, payload, device_id, lamport)
   VALUES (?, ?, ?, ?, ?, ?)`
);

/**
 * Append a single row to the event log. Must be called inside the same
 * transaction as the task mutation itself so we never have a task change
 * without a matching event (or vice versa).
 */
function recordEvent(
  op: "create" | "complete" | "uncomplete" | "edit" | "delete",
  taskUuid: string,
  payload: Record<string, unknown> | null
): void {
  insertEventStmt.run(
    randomUUID(),
    taskUuid,
    op,
    payload === null ? null : JSON.stringify(payload),
    DEVICE_ID,
    nextLamport()
  );
}

const insertTaskStmt = db.prepare(
  `INSERT INTO tasks (uuid, text, due_at, source, fingerprint) VALUES (?, ?, ?, ?, ?) RETURNING *`
);

const findOpenByFingerprintStmt = db.prepare(
  `SELECT * FROM tasks WHERE fingerprint = ? AND completed_at IS NULL LIMIT 1`
);

const countDoneTodayStmt = db.prepare(
  `SELECT COUNT(*) as n FROM tasks WHERE completed_at IS NOT NULL AND date(completed_at) = date('now')`
);

const selectOpenStmt = db.prepare(
  `SELECT * FROM tasks WHERE completed_at IS NULL ORDER BY
     CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at ASC, created_at ASC`
);

const selectAllStmt = db.prepare(
  `SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?`
);

const selectRecentDoneStmt = db.prepare(
  `SELECT * FROM tasks
   WHERE completed_at IS NOT NULL
     AND completed_at >= datetime('now', ?)
   ORDER BY completed_at DESC`
);

const selectArchivedStmt = db.prepare(
  `SELECT * FROM tasks
   WHERE completed_at IS NOT NULL
     AND completed_at < datetime('now', ?)
   ORDER BY completed_at DESC
   LIMIT ?`
);

const completeTaskFindStmt = db.prepare(
  `SELECT uuid, completed_at FROM tasks WHERE id = ?`
);

const completeTaskUpdateStmt = db.prepare(
  `UPDATE tasks SET completed_at = datetime('now') WHERE id = ? AND completed_at IS NULL`
);

const getTaskStmt = db.prepare(`SELECT * FROM tasks WHERE id = ?`);

export function fingerprint(text: string): string {
  return createHash("sha256")
    .update(text.toLowerCase().replace(/\s+/g, " ").trim())
    .digest("hex")
    .slice(0, 16);
}

export function addTask(
  text: string,
  dueAt: string | null = null,
  source = "claude"
): Task {
  const taskUuid = randomUUID();
  const fp = fingerprint(text);
  const inside = db.transaction((): Task => {
    const task = insertTaskStmt.get(taskUuid, text, dueAt, source, fp) as Task;
    recordEvent("create", taskUuid, { text, due_at: dueAt, source });
    return task;
  });
  return inside();
}

/**
 * Insert only if no open task with the same fingerprint exists.
 * Returns the new task, or the existing duplicate when skipped.
 * The event is only emitted on actual insertion.
 */
export function addTaskUnique(
  text: string,
  dueAt: string | null = null,
  source = "claude"
): { task: Task; inserted: boolean } {
  const fp = fingerprint(text);
  const inside = db.transaction((): { task: Task; inserted: boolean } => {
    const existing = findOpenByFingerprintStmt.get(fp) as Task | undefined;
    if (existing) return { task: existing, inserted: false };
    const taskUuid = randomUUID();
    const task = insertTaskStmt.get(taskUuid, text, dueAt, source, fp) as Task;
    recordEvent("create", taskUuid, { text, due_at: dueAt, source });
    return { task, inserted: true };
  });
  return inside();
}

export function countDoneToday(): number {
  return (countDoneTodayStmt.get() as { n: number }).n;
}

export function listOpenTasks(): Task[] {
  return selectOpenStmt.all() as Task[];
}

export function listAllTasks(limit = 50): Task[] {
  return selectAllStmt.all(limit) as Task[];
}

export function listRecentlyCompleted(hoursAgo = 24): Task[] {
  return selectRecentDoneStmt.all(`-${hoursAgo} hours`) as Task[];
}

export function listArchived(hoursAgo = 24, limit = 100): Task[] {
  return selectArchivedStmt.all(`-${hoursAgo} hours`, limit) as Task[];
}

/**
 * Complete a task by numeric id (what the MCP surface accepts). Only emits
 * a `complete` event if the task was actually open before the call; no-op
 * on already-completed or nonexistent ids, matching prior behavior.
 */
export function completeTask(id: number): Task | null {
  const inside = db.transaction((): Task | null => {
    const prior = completeTaskFindStmt.get(id) as
      | { uuid: string; completed_at: string | null }
      | undefined;
    if (!prior) return null;
    if (prior.completed_at === null) {
      completeTaskUpdateStmt.run(id);
      recordEvent("complete", prior.uuid, null);
    }
    return (getTaskStmt.get(id) as Task | undefined) ?? null;
  });
  return inside();
}

export function getTask(id: number): Task | null {
  return (getTaskStmt.get(id) as Task | undefined) ?? null;
}

export { DB_PATH, DEVICE_ID };
