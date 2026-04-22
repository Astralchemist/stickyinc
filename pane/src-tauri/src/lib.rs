use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

mod wizard;

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

use crate::wizard::{
    open_wizard, open_wizard_window, setup_is_complete, wizard_close,
    wizard_detect_subscriptions, wizard_diff_claude_json, wizard_mark_complete,
    wizard_read_llm_config, wizard_register_mcp, wizard_save_llm_config,
    wizard_set_watcher_enabled, wizard_validate_llm_key,
};

#[derive(Debug, Serialize, Clone)]
pub struct Task {
    pub id: i64,
    pub uuid: String,
    pub text: String,
    pub created_at: String,
    pub completed_at: Option<String>,
    pub due_at: Option<String>,
    pub source: String,
}

struct DbPath(PathBuf);

fn db_path() -> PathBuf {
    let mut p = dirs::home_dir().expect("no home dir");
    p.push(".stickyinc");
    std::fs::create_dir_all(&p).ok();
    p.push("tasks.db");
    p
}

fn open_db(path: &PathBuf) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    // Phase 1: tables + indexes that don't depend on columns the migrations
    // below add. Creating the uuid UNIQUE INDEX here would fail on pre-v0.6
    // databases where the column doesn't exist yet.
    conn.execute_batch(
        r#"
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
        "#,
    )?;
    // Phase 2: column-adding migrations.
    migrate_add_fingerprint(&conn)?;
    migrate_add_uuid(&conn)?;
    // Phase 3: indexes on migrated columns.
    conn.execute_batch(
        r#"
        CREATE INDEX IF NOT EXISTS idx_tasks_fingerprint ON tasks(fingerprint);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_uuid ON tasks(uuid);
        "#,
    )?;
    Ok(conn)
}

/// Idempotent migration: add `uuid` column to pre-v0.6 tasks tables and
/// backfill one for every existing row. Safe to run on fresh DBs too —
/// the column already exists and the UPDATE WHERE uuid IS NULL is a noop.
fn migrate_add_uuid(conn: &Connection) -> rusqlite::Result<()> {
    let has_col: bool = {
        let mut stmt = conn.prepare("SELECT 1 FROM pragma_table_info('tasks') WHERE name = 'uuid'")?;
        stmt.exists([])?
    };
    if !has_col {
        conn.execute("ALTER TABLE tasks ADD COLUMN uuid TEXT", [])?;
    }
    // Backfill — select first (borrow ends), then update in a separate statement.
    let pending: Vec<i64> = {
        let mut stmt = conn.prepare("SELECT id FROM tasks WHERE uuid IS NULL")?;
        let rows = stmt.query_map([], |row| row.get::<_, i64>(0))?;
        rows.filter_map(|r| r.ok()).collect()
    };
    for id in pending {
        let u = uuid::Uuid::new_v4().to_string();
        conn.execute("UPDATE tasks SET uuid = ? WHERE id = ?", rusqlite::params![u, id])?;
    }
    // The UNIQUE INDEX was CREATE'd with IF NOT EXISTS in open_db; now that all
    // rows have a uuid, it's valid.
    Ok(())
}

/// Idempotent migration: ensure fingerprint column exists on older DBs.
/// Matches what src/db.ts already does on the Node side, so both programs
/// agree on the schema regardless of which one touched the file first.
fn migrate_add_fingerprint(conn: &Connection) -> rusqlite::Result<()> {
    let has_col: bool = {
        let mut stmt = conn.prepare("SELECT 1 FROM pragma_table_info('tasks') WHERE name = 'fingerprint'")?;
        stmt.exists([])?
    };
    if !has_col {
        conn.execute("ALTER TABLE tasks ADD COLUMN fingerprint TEXT", [])?;
    }
    Ok(())
}

/// Fetch (or generate + persist) this machine's device_id. Used to stamp
/// every task_events row so future sync can filter by origin.
fn ensure_device_id(conn: &Connection) -> rusqlite::Result<String> {
    let existing: Option<String> = conn
        .query_row("SELECT value FROM meta WHERE key = 'device_id'", [], |row| row.get(0))
        .optional()?;
    if let Some(id) = existing {
        return Ok(id);
    }
    let id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT OR IGNORE INTO meta (key, value) VALUES ('device_id', ?)",
        [&id],
    )?;
    // In the rare race where another process inserted first, read it back.
    let final_id: String = conn.query_row(
        "SELECT value FROM meta WHERE key = 'device_id'",
        [],
        |row| row.get(0),
    )?;
    Ok(final_id)
}

/// Next Lamport-style counter for this device. Monotonic per device,
/// independent across devices — that's all we need for deterministic
/// replay ordering when merging event streams later.
fn next_lamport(conn: &Connection, device_id: &str) -> rusqlite::Result<i64> {
    let current: Option<i64> = conn
        .query_row(
            "SELECT MAX(lamport) FROM task_events WHERE device_id = ?",
            [device_id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(current.unwrap_or(0) + 1)
}

/// Append a single row to the event log. Called inside the same transaction
/// as the task mutation itself so we never have a task change without a
/// matching event (or vice versa).
fn record_event(
    conn: &Connection,
    op: &str,
    task_uuid: &str,
    payload: Option<&serde_json::Value>,
) -> rusqlite::Result<()> {
    let device_id = ensure_device_id(conn)?;
    let lamport = next_lamport(conn, &device_id)?;
    let event_uuid = uuid::Uuid::new_v4().to_string();
    let payload_str: Option<String> = payload.map(|p| p.to_string());
    conn.execute(
        "INSERT INTO task_events (event_uuid, task_uuid, op, payload, device_id, lamport)
         VALUES (?, ?, ?, ?, ?, ?)",
        rusqlite::params![event_uuid, task_uuid, op, payload_str, device_id, lamport],
    )?;
    Ok(())
}

#[tauri::command]
fn list_open_tasks(db: tauri::State<'_, Mutex<DbPath>>) -> Result<Vec<Task>, String> {
    let path = db.lock().unwrap().0.clone();
    let conn = open_db(&path).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, uuid, text, created_at, completed_at, due_at, source
             FROM tasks
             WHERE completed_at IS NULL
             ORDER BY CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at ASC, created_at ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(Task {
                id: row.get(0)?,
                uuid: row.get(1)?,
                text: row.get(2)?,
                created_at: row.get(3)?,
                completed_at: row.get(4)?,
                due_at: row.get(5)?,
                source: row.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

#[tauri::command]
fn list_recent_done(
    hours: Option<i64>,
    db: tauri::State<'_, Mutex<DbPath>>,
) -> Result<Vec<Task>, String> {
    let hours = hours.unwrap_or(24);
    let path = db.lock().unwrap().0.clone();
    let conn = open_db(&path).map_err(|e| e.to_string())?;
    let modifier = format!("-{} hours", hours);
    let mut stmt = conn
        .prepare(
            "SELECT id, uuid, text, created_at, completed_at, due_at, source
             FROM tasks
             WHERE completed_at IS NOT NULL
               AND completed_at >= datetime('now', ?)
             ORDER BY completed_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([modifier], |row| {
            Ok(Task {
                id: row.get(0)?,
                uuid: row.get(1)?,
                text: row.get(2)?,
                created_at: row.get(3)?,
                completed_at: row.get(4)?,
                due_at: row.get(5)?,
                source: row.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

#[tauri::command]
fn list_archived_done(
    hours: Option<i64>,
    limit: Option<i64>,
    db: tauri::State<'_, Mutex<DbPath>>,
) -> Result<Vec<Task>, String> {
    let hours = hours.unwrap_or(24);
    let limit = limit.unwrap_or(100);
    let path = db.lock().unwrap().0.clone();
    let conn = open_db(&path).map_err(|e| e.to_string())?;
    let modifier = format!("-{} hours", hours);
    let mut stmt = conn
        .prepare(
            "SELECT id, uuid, text, created_at, completed_at, due_at, source
             FROM tasks
             WHERE completed_at IS NOT NULL
               AND completed_at < datetime('now', ?)
             ORDER BY completed_at DESC
             LIMIT ?",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![modifier, limit], |row| {
            Ok(Task {
                id: row.get(0)?,
                uuid: row.get(1)?,
                text: row.get(2)?,
                created_at: row.get(3)?,
                completed_at: row.get(4)?,
                due_at: row.get(5)?,
                source: row.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

#[tauri::command]
fn add_task_quickadd(
    text: String,
    db: tauri::State<'_, Mutex<DbPath>>,
) -> Result<Task, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("empty".into());
    }

    let (task_text, due_at) = parse_inline_due(trimmed);

    let path = db.lock().unwrap().0.clone();
    let mut conn = open_db(&path).map_err(|e| e.to_string())?;

    let task_uuid = uuid::Uuid::new_v4().to_string();
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO tasks (uuid, text, due_at, source, fingerprint) VALUES (?, ?, ?, 'quickadd', ?)",
        rusqlite::params![
            task_uuid,
            task_text,
            due_at,
            fingerprint(&task_text),
        ],
    )
    .map_err(|e| e.to_string())?;

    let payload = serde_json::json!({
        "text": task_text,
        "due_at": due_at,
        "source": "quickadd",
    });
    record_event(&tx, "create", &task_uuid, Some(&payload)).map_err(|e| e.to_string())?;

    let task = tx
        .query_row(
            "SELECT id, uuid, text, created_at, completed_at, due_at, source FROM tasks WHERE uuid = ?",
            [&task_uuid],
            |row| {
                Ok(Task {
                    id: row.get(0)?,
                    uuid: row.get(1)?,
                    text: row.get(2)?,
                    created_at: row.get(3)?,
                    completed_at: row.get(4)?,
                    due_at: row.get(5)?,
                    source: row.get(6)?,
                })
            },
        )
        .map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;
    Ok(task)
}

fn parse_inline_due(text: &str) -> (String, Option<String>) {
    // Look for a trailing "due:YYYY-MM-DD" or "due:YYYY-MM-DDTHH:MM"
    if let Some(idx) = text.rfind(" due:") {
        let (head, tail) = text.split_at(idx);
        let due_raw = tail.trim_start_matches(" due:").trim();
        if !due_raw.is_empty() {
            let due = if due_raw.contains('T') {
                format!("{}:00Z", due_raw.trim_end_matches('Z').trim_end_matches(":00"))
            } else {
                format!("{}T09:00:00Z", due_raw)
            };
            return (head.trim().to_string(), Some(due));
        }
    }
    (text.to_string(), None)
}

fn fingerprint(text: &str) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    text.to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .hash(&mut h);
    format!("{:016x}", h.finish())
}

fn open_or_show_quickadd(app: &tauri::AppHandle) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window("quickadd") {
        let _ = w.show();
        let _ = w.set_focus();
        let _ = w.center();
        return Ok(());
    }
    let url = WebviewUrl::App("quickadd.html".into());
    let win = WebviewWindowBuilder::new(app, "quickadd", url)
        .title("StickyInc — Quick Add")
        .inner_size(420.0, 64.0)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .resizable(false)
        .skip_taskbar(true)
        .focused(true)
        .center()
        .build()?;
    let _ = win.show();
    let _ = win.set_focus();
    Ok(())
}

#[tauri::command]
fn complete_task(id: i64, db: tauri::State<'_, Mutex<DbPath>>) -> Result<Option<Task>, String> {
    let path = db.lock().unwrap().0.clone();
    let mut conn = open_db(&path).map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    // Look up the task's uuid *and* whether it was open before we toggle;
    // only-still-open transitions get an event written.
    let prior: Option<(String, Option<String>)> = tx
        .query_row(
            "SELECT uuid, completed_at FROM tasks WHERE id = ?",
            [id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;

    if let Some((task_uuid, completed_at)) = prior.clone() {
        if completed_at.is_none() {
            tx.execute(
                "UPDATE tasks SET completed_at = datetime('now') WHERE id = ? AND completed_at IS NULL",
                [id],
            )
            .map_err(|e| e.to_string())?;
            record_event(&tx, "complete", &task_uuid, None).map_err(|e| e.to_string())?;
        }
    }

    let task = tx
        .query_row(
            "SELECT id, uuid, text, created_at, completed_at, due_at, source FROM tasks WHERE id = ?",
            [id],
            |row| {
                Ok(Task {
                    id: row.get(0)?,
                    uuid: row.get(1)?,
                    text: row.get(2)?,
                    created_at: row.get(3)?,
                    completed_at: row.get(4)?,
                    due_at: row.get(5)?,
                    source: row.get(6)?,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;
    let _ = prior;
    Ok(task)
}

#[tauri::command]
fn close_quickadd(window: tauri::Window) -> Result<(), String> {
    if window.label() == "quickadd" {
        window.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn get_setup_complete() -> bool {
    setup_is_complete()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let path = db_path();
    // Ensure schema exists before watcher fires.
    open_db(&path).expect("init db");

    tauri::Builder::default()
        .manage(Mutex::new(DbPath(path.clone())))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    let trigger = Shortcut::new(
                        Some(Modifiers::SUPER | Modifiers::SHIFT),
                        Code::KeyN,
                    );
                    let trigger_alt = Shortcut::new(
                        Some(Modifiers::CONTROL | Modifiers::SHIFT),
                        Code::KeyN,
                    );
                    if event.state() == ShortcutState::Pressed
                        && (shortcut == &trigger || shortcut == &trigger_alt)
                    {
                        let _ = open_or_show_quickadd(app);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            list_open_tasks,
            list_recent_done,
            list_archived_done,
            complete_task,
            add_task_quickadd,
            close_quickadd,
            get_setup_complete,
            open_wizard,
            wizard_close,
            wizard_detect_subscriptions,
            wizard_diff_claude_json,
            wizard_register_mcp,
            wizard_read_llm_config,
            wizard_save_llm_config,
            wizard_validate_llm_key,
            wizard_set_watcher_enabled,
            wizard_mark_complete
        ])
        .setup(move |app| {
            use tauri_plugin_global_shortcut::GlobalShortcutExt;
            let gs = app.global_shortcut();
            // Try macOS (Cmd), then fall back to Ctrl for Linux/Windows.
            let _ = gs.register(Shortcut::new(
                Some(Modifiers::SUPER | Modifiers::SHIFT),
                Code::KeyN,
            ));
            let _ = gs.register(Shortcut::new(
                Some(Modifiers::CONTROL | Modifiers::SHIFT),
                Code::KeyN,
            ));

            // First-run: open the setup wizard automatically.
            if !setup_is_complete() {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(600));
                    let _ = open_wizard_window(&handle);
                });
            }

            let handle = app.handle().clone();
            let watch_path = path.clone();
            std::thread::spawn(move || {
                let (tx, rx) = std::sync::mpsc::channel::<notify::Result<Event>>();
                let mut watcher: RecommendedWatcher = match notify::recommended_watcher(tx) {
                    Ok(w) => w,
                    Err(e) => {
                        eprintln!("watcher init failed: {e}");
                        return;
                    }
                };
                if let Err(e) = watcher.watch(&watch_path, RecursiveMode::NonRecursive) {
                    eprintln!("watch failed: {e}");
                    return;
                }
                loop {
                    match rx.recv_timeout(Duration::from_secs(5)) {
                        Ok(Ok(_event)) => {
                            let _ = handle.emit("tasks-changed", ());
                        }
                        Ok(Err(e)) => eprintln!("watch event err: {e}"),
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
