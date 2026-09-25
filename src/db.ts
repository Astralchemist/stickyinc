import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
// Built-in driver (Node 22.13+), not better-sqlite3: the pane ships this
// server as a single bundled file run by the user's own `node`, and a native
// addon can't be bundled or matched to an unknown Node ABI.
import { DatabaseSync } from "node:sqlite";
import type { Due } from "./dates.js";
import type { Task } from "./types.js";

/**
 * ~/.stickyinc/tasks.db unless STICKYINC_DB says otherwise. The pane always
 * reads the default, so an override is for a list the pane won't show. A
 * leading ~ is expanded since MCP client configs don't go through a shell.
 */
function dbPath(): string {
  const override = process.env.STICKYINC_DB;
  if (!override) return join(homedir(), ".stickyinc", "tasks.db");
  return resolve(override.replace(/^~(?=$|[\\/])/, homedir()));
}

const DB_PATH = dbPath();

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;`);

/**
 * Run `fn` in a write transaction. IMMEDIATE takes the write lock up front,
 * so read-then-write bodies wait on busy_timeout instead of failing with
 * SQLITE_BUSY when the pane or watcher commits in between.
 */
function inTransaction<T>(fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

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
    due_phrase TEXT,
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
  // The words a due date was read from. Node-only: the pane never sets it.
  if (!cols.some((c) => c.name === "due_phrase")) {
    db.exec(`ALTER TABLE tasks ADD COLUMN due_phrase TEXT`);
  }
  // Backfill uuid for any rows created before v0.6.
  const pending = db.prepare(`SELECT id FROM tasks WHERE uuid IS NULL`).all() as {
    id: number;
  }[];
  if (pending.length > 0) {
    const setUuid = db.prepare(`UPDATE tasks SET uuid = ? WHERE id = ?`);
    inTransaction(() => {
      for (const row of pending) setUuid.run(randomUUID(), row.id);
    });
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
  `INSERT INTO tasks (uuid, text, due_at, due_phrase, source, fingerprint)
   VALUES (?, ?, ?, ?, ?, ?) RETURNING *`
);

const findOpenByFingerprintStmt = db.prepare(
  `SELECT * FROM tasks WHERE fingerprint = ? AND completed_at IS NULL LIMIT 1`
);

const countDoneTodayStmt = db.prepare(
  `SELECT COUNT(*) as n FROM tasks WHERE completed_at IS NOT NULL
     AND date(completed_at, 'localtime') = date('now', 'localtime')`
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

/**
 * Insert a task and its create event; call inside inTransaction. The event
 * also records when a due phrase was read, so the parse can be replayed.
 */
function insertTask(text: string, due: Due | null, source: string): Task {
  const taskUuid = randomUUID();
  const dueAt = due?.at ?? null;
  const duePhrase = due?.phrase ?? null;
  const task = insertTaskStmt.get(
    taskUuid, text, dueAt, duePhrase, source, fingerprint(text)
  ) as unknown as Task;
  recordEvent("create", taskUuid, {
    text,
    due_at: dueAt,
    due_phrase: duePhrase,
    due_ref: due?.ref ?? null,
    source,
  });
  return task;
}

export function addTask(text: string, due: Due | null = null, source = "claude"): Task {
  return inTransaction(() => insertTask(text, due, source));
}

/**
 * Insert only if no open task with the same fingerprint exists.
 * Returns the new task, or the existing duplicate when skipped.
 * The event is only emitted on actual insertion.
 */
export function addTaskUnique(
  text: string,
  due: Due | null = null,
  source = "claude"
): { task: Task; inserted: boolean } {
  return inTransaction((): { task: Task; inserted: boolean } => {
    const existing = findOpenByFingerprintStmt.get(fingerprint(text)) as Task | undefined;
    if (existing) return { task: existing, inserted: false };
    return { task: insertTask(text, due, source), inserted: true };
  });
}

export function countDoneToday(): number {
  return (countDoneTodayStmt.get() as { n: number }).n;
}

export function listOpenTasks(): Task[] {
  return selectOpenStmt.all() as unknown as Task[];
}

export function listAllTasks(limit = 50): Task[] {
  return selectAllStmt.all(limit) as unknown as Task[];
}

export function listRecentlyCompleted(hoursAgo = 24): Task[] {
  return selectRecentDoneStmt.all(`-${hoursAgo} hours`) as unknown as Task[];
}

export function listArchived(hoursAgo = 24, limit = 100): Task[] {
  return selectArchivedStmt.all(`-${hoursAgo} hours`, limit) as unknown as Task[];
}

/**
 * Complete a task by numeric id (what the MCP surface accepts). Only emits
 * a `complete` event if the task was actually open before the call.
 * Returns null for a nonexistent id; `completed` says whether this call
 * closed it (false: it was already done).
 */
export function completeTask(id: number): { task: Task; completed: boolean } | null {
  return inTransaction(() => {
    const prior = completeTaskFindStmt.get(id) as
      | { uuid: string; completed_at: string | null }
      | undefined;
    if (!prior) return null;
    const completed = prior.completed_at === null;
    if (completed) {
      completeTaskUpdateStmt.run(id);
      recordEvent("complete", prior.uuid, null);
    }
    return { task: getTaskStmt.get(id) as unknown as Task, completed };
  });
}

export { DB_PATH, DEVICE_ID };
