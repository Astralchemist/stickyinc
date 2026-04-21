import Database from "better-sqlite3";
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
    source TEXT NOT NULL DEFAULT 'claude'
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_completed ON tasks(completed_at);
  CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_at);
`);

const insertTaskStmt = db.prepare(
  `INSERT INTO tasks (text, due_at, source) VALUES (?, ?, ?) RETURNING *`
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

export function addTask(
  text: string,
  dueAt: string | null = null,
  source = "claude"
): Task {
  return insertTaskStmt.get(text, dueAt, source) as Task;
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
