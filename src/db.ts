import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Task } from "./types.js";

const DATA_DIR = join(homedir(), ".stickyinc");
const DB_PATH = join(DATA_DIR, "tasks.db");

mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT,
    due_at TEXT,
    source TEXT NOT NULL DEFAULT 'claude',
    fingerprint TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_completed ON tasks(completed_at);
  CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_at);
  CREATE INDEX IF NOT EXISTS idx_tasks_fingerprint ON tasks(fingerprint);
`);

// Migration: add fingerprint column to pre-v0.4 databases
const cols = db.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[];
if (!cols.some((c) => c.name === "fingerprint")) {
  db.exec(`ALTER TABLE tasks ADD COLUMN fingerprint TEXT`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_fingerprint ON tasks(fingerprint)`);
}

const insertTaskStmt = db.prepare(
  `INSERT INTO tasks (text, due_at, source, fingerprint) VALUES (?, ?, ?, ?) RETURNING *`
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

const completeTaskStmt = db.prepare(
  `UPDATE tasks SET completed_at = datetime('now') WHERE id = ? AND completed_at IS NULL RETURNING *`
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
  return insertTaskStmt.get(text, dueAt, source, fingerprint(text)) as Task;
}

/**
 * Insert only if no open task with the same fingerprint exists.
 * Returns the new task, or the existing duplicate when skipped.
 */
export function addTaskUnique(
  text: string,
  dueAt: string | null = null,
  source = "claude"
): { task: Task; inserted: boolean } {
  const fp = fingerprint(text);
  const existing = findOpenByFingerprintStmt.get(fp) as Task | undefined;
  if (existing) return { task: existing, inserted: false };
  const task = insertTaskStmt.get(text, dueAt, source, fp) as Task;
  return { task, inserted: true };
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

export function completeTask(id: number): Task | null {
  return (completeTaskStmt.get(id) as Task | undefined) ?? null;
}

export function getTask(id: number): Task | null {
  return (getTaskStmt.get(id) as Task | undefined) ?? null;
}

export { DB_PATH };
