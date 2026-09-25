use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

mod passive;
mod reminders_sync;
mod wizard;

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

use crate::wizard::{
    open_wizard, open_wizard_window, setup_is_complete, wizard_close,
    wizard_detect_subscriptions, wizard_diff_claude_json, wizard_list_openrouter_models,
    wizard_mark_complete, wizard_read_llm_config, wizard_read_reminders_sync,
    wizard_read_watcher_enabled, wizard_register_mcp, wizard_save_llm_config, wizard_set_reminders_sync,
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
    /// Provenance, shown on hover: the app it came from, a pointer back,
    /// and the words it came from. Set by the MCP server and the watcher.
    pub source_client: Option<String>,
    pub source_ref: Option<String>,
    pub source_excerpt: Option<String>,
}

/// The columns `task_from_row` reads, in its order.
const TASK_COLS: &str =
    "id, uuid, text, created_at, completed_at, due_at, source, source_client, source_ref, source_excerpt";

fn task_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Task> {
    Ok(Task {
        id: row.get(0)?,
        uuid: row.get(1)?,
        text: row.get(2)?,
        created_at: row.get(3)?,
        completed_at: row.get(4)?,
        due_at: row.get(5)?,
        source: row.get(6)?,
        source_client: row.get(7)?,
        source_ref: row.get(8)?,
        source_excerpt: row.get(9)?,
    })
}

struct DbPath(PathBuf);

fn db_path() -> PathBuf {
    let mut p = dirs::home_dir().expect("no home dir");
    p.push(".stickyinc");
    std::fs::create_dir_all(&p).ok();
    p.push("tasks.db");
    p
}

/// ~/.stickyinc/stickyinc.ics, which calendars subscribe to or import.
fn calendar_path() -> PathBuf {
    db_path().with_file_name("stickyinc.ics")
}

/// Write via a temp file and a rename, so a calendar reading it mid-update
/// sees the old file or the new one, never half of one.
fn write_atomically(path: &std::path::Path, contents: &str) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, contents)?;
    std::fs::rename(&tmp, path)
}

/// The pane builds the calendar file (src/calendar.ts, with the ics
/// package) whenever its dated tasks change; this puts it on disk.
#[tauri::command]
fn write_calendar(ics: String) -> Result<(), String> {
    write_atomically(&calendar_path(), &ics).map_err(|e| e.to_string())
}

/// Where the calendar file is, for Settings to show and copy.
#[tauri::command]
fn calendar_file_path() -> String {
    calendar_path().to_string_lossy().into_owned()
}

fn open_db(path: &PathBuf) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.busy_timeout(Duration::from_secs(5))?;
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
            due_phrase TEXT,
            source TEXT NOT NULL DEFAULT 'claude',
            fingerprint TEXT,
            source_client TEXT,
            source_ref TEXT,
            source_excerpt TEXT
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

        -- A task's copy in another app (reminders_sync.rs): its id there and
        -- what it was last sent, so syncs never duplicate and only send changes.
        CREATE TABLE IF NOT EXISTS task_external (
            task_uuid TEXT NOT NULL,
            provider TEXT NOT NULL,
            external_id TEXT NOT NULL,
            sent TEXT NOT NULL,
            PRIMARY KEY (task_uuid, provider)
        );
        CREATE INDEX IF NOT EXISTS idx_task_events_lamport ON task_events(device_id, lamport);
        "#,
    )?;
    // Phase 2: column-adding migrations.
    migrate_add_fingerprint(&conn)?;
    migrate_add_uuid(&conn)?;
    migrate_fingerprint_sha256(&conn)?;
    migrate_add_provenance(&conn)?;
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

/// Idempotent migration: nullable columns the Node side also adds, so
/// whichever program opens an older DB first brings it up to date: the
/// provenance task_from_row reads, and due_phrase, which snooze clears.
fn migrate_add_provenance(conn: &Connection) -> rusqlite::Result<()> {
    for col in ["source_client", "source_ref", "source_excerpt", "due_phrase"] {
        let has_col = conn
            .prepare("SELECT 1 FROM pragma_table_info('tasks') WHERE name = ?")?
            .exists([col])?;
        if !has_col {
            conn.execute(&format!("ALTER TABLE tasks ADD COLUMN {col} TEXT"), [])?;
        }
    }
    Ok(())
}

/// One-time migration: quick-add fingerprints used to be a Rust-only hash
/// (DefaultHasher) that never matched the Node side's, so dedup across quick
/// add and the MCP server / watcher didn't work. Recompute them with the
/// shared algorithm; a meta flag makes this run once.
fn migrate_fingerprint_sha256(conn: &Connection) -> rusqlite::Result<()> {
    let done = conn
        .prepare("SELECT 1 FROM meta WHERE key = 'fingerprint_sha256'")?
        .exists([])?;
    if done {
        return Ok(());
    }
    let tx = conn.unchecked_transaction()?;
    let rows: Vec<(i64, String)> = {
        let mut stmt = tx.prepare("SELECT id, text FROM tasks WHERE source = 'quickadd'")?;
        let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    for (id, text) in rows {
        tx.execute(
            "UPDATE tasks SET fingerprint = ? WHERE id = ?",
            rusqlite::params![fingerprint(&text), id],
        )?;
    }
    tx.execute(
        "INSERT OR IGNORE INTO meta (key, value) VALUES ('fingerprint_sha256', '1')",
        [],
    )?;
    tx.commit()
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
    // MAX over no rows is one row holding NULL, not zero rows.
    let current: Option<i64> = conn.query_row(
        "SELECT MAX(lamport) FROM task_events WHERE device_id = ?",
        [device_id],
        |row| row.get(0),
    )?;
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
        .prepare(&format!(
            "SELECT {TASK_COLS}
             FROM tasks
             WHERE completed_at IS NULL
             ORDER BY CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at ASC, created_at ASC",
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], task_from_row)
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
        .prepare(&format!(
            "SELECT {TASK_COLS}
             FROM tasks
             WHERE completed_at IS NOT NULL
               AND completed_at >= datetime('now', ?)
             ORDER BY completed_at DESC",
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([modifier], task_from_row)
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
        .prepare(&format!(
            "SELECT {TASK_COLS}
             FROM tasks
             WHERE completed_at IS NOT NULL
               AND completed_at < datetime('now', ?)
             ORDER BY completed_at DESC
             LIMIT ?",
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![modifier, limit], task_from_row)
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
    // IMMEDIATE takes the write lock up front: a deferred transaction that
    // reads first fails with SQLITE_BUSY (no retry) if the MCP server or
    // watcher commits before it writes.
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
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
            &format!("SELECT {TASK_COLS} FROM tasks WHERE uuid = ?"),
            [&task_uuid],
            task_from_row,
        )
        .map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;
    Ok(task)
}

/// Split a trailing " due:YYYY-MM-DD" or " due:YYYY-MM-DDTHH:MM[:SS]" off
/// quick-add text. Times are the user's local time (a trailing Z means UTC);
/// a bare date means 09:00 local. Stored as UTC ISO 8601, the same shape the
/// MCP server writes. Anything unparseable stays part of the task text
/// rather than being stored as a bogus due date.
fn parse_inline_due(text: &str) -> (String, Option<String>) {
    use chrono::{Local, NaiveDate, NaiveDateTime, TimeZone, Utc};

    let Some(idx) = text.rfind(" due:") else {
        return (text.to_string(), None);
    };
    let (head, tail) = text.split_at(idx);
    let raw = tail.trim_start_matches(" due:").trim();
    let (raw, is_utc) = match raw.strip_suffix('Z') {
        Some(r) => (r, true),
        None => (raw, false),
    };
    let naive = NaiveDateTime::parse_from_str(raw, "%Y-%m-%dT%H:%M")
        .or_else(|_| NaiveDateTime::parse_from_str(raw, "%Y-%m-%dT%H:%M:%S"))
        .ok()
        .or_else(|| {
            NaiveDate::parse_from_str(raw, "%Y-%m-%d")
                .ok()
                .and_then(|d| d.and_hms_opt(9, 0, 0))
        });
    let utc = naive.and_then(|n| {
        if is_utc {
            Some(Utc.from_utc_datetime(&n))
        } else {
            // earliest(): on a DST fall-back the wall time exists twice.
            Local.from_local_datetime(&n).earliest().map(|t| t.with_timezone(&Utc))
        }
    });
    match utc {
        Some(t) => (head.trim().to_string(), Some(t.format("%Y-%m-%dT%H:%M:%SZ").to_string())),
        None => (text.to_string(), None),
    }
}

/// Same algorithm as `fingerprint` in src/db.ts, so quick-add tasks and ones
/// the MCP server or watcher add dedupe against each other: sha256 of the
/// lowercased, whitespace-collapsed text, first 16 hex chars.
fn fingerprint(text: &str) -> String {
    use sha2::{Digest, Sha256};
    let normalized = text.to_lowercase().split_whitespace().collect::<Vec<_>>().join(" ");
    Sha256::digest(normalized.as_bytes())
        .iter()
        .take(8)
        .map(|b| format!("{:02x}", b))
        .collect()
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

/// Snooze from the pane: move an open task's due time to `until` (RFC 3339).
/// due_phrase no longer says when it's due, so it's cleared; the edit event
/// keeps the old and new times.
#[tauri::command]
fn snooze_task(id: i64, until: String, db: tauri::State<'_, Mutex<DbPath>>) -> Result<(), String> {
    let path = db.lock().unwrap().0.clone();
    let mut conn = open_db(&path).map_err(|e| e.to_string())?;
    snooze(&mut conn, id, &until)
}

fn snooze(conn: &mut Connection, id: i64, until: &str) -> Result<(), String> {
    let until = chrono::DateTime::parse_from_rfc3339(until)
        .map_err(|e| format!("snooze time {until:?}: {e}"))?
        .with_timezone(&chrono::Utc)
        .format("%Y-%m-%dT%H:%M:%SZ")
        .to_string();
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let (task_uuid, was): (String, Option<String>) = tx
        .query_row(
            "SELECT uuid, due_at FROM tasks WHERE id = ? AND completed_at IS NULL",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("no open task #{id}"))?;
    tx.execute(
        "UPDATE tasks SET due_at = ?, due_phrase = NULL WHERE id = ?",
        rusqlite::params![until, id],
    )
    .map_err(|e| e.to_string())?;
    let payload = serde_json::json!({ "due_at": until, "snoozed_from": was });
    record_event(&tx, "edit", &task_uuid, Some(&payload)).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

#[tauri::command]
fn complete_task(id: i64, db: tauri::State<'_, Mutex<DbPath>>) -> Result<Option<Task>, String> {
    let path = db.lock().unwrap().0.clone();
    let mut conn = open_db(&path).map_err(|e| e.to_string())?;
    // IMMEDIATE takes the write lock up front: a deferred transaction that
    // reads first fails with SQLITE_BUSY (no retry) if the MCP server or
    // watcher commits before it writes.
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;

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
            &format!("SELECT {TASK_COLS} FROM tasks WHERE id = ?"),
            [id],
            task_from_row,
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
        .manage(passive::PassiveWatcher::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
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
            write_calendar,
            calendar_file_path,
            snooze_task,
            get_setup_complete,
            open_wizard,
            wizard_close,
            wizard_detect_subscriptions,
            wizard_diff_claude_json,
            wizard_list_openrouter_models,
            wizard_register_mcp,
            wizard_read_llm_config,
            wizard_read_watcher_enabled,
            wizard_read_reminders_sync,
            wizard_set_reminders_sync,
            reminders_sync::sync_reminders,
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

            if let Err(e) = app.state::<passive::PassiveWatcher>().sync(app.handle()) {
                eprintln!("passive watcher: {e}");
            }

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
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                app.state::<passive::PassiveWatcher>().stop();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn due_with_z_is_utc() {
        assert_eq!(
            parse_inline_due("ship it due:2026-04-25T15:30Z"),
            ("ship it".to_string(), Some("2026-04-25T15:30:00Z".to_string()))
        );
    }

    #[test]
    fn bare_date_is_nine_am_local() {
        use chrono::{DateTime, Local, Timelike};
        let (text, due) = parse_inline_due("buy bread due:2026-04-25");
        assert_eq!(text, "buy bread");
        let local = DateTime::parse_from_rfc3339(&due.unwrap()).unwrap().with_timezone(&Local);
        assert_eq!(local.format("%Y-%m-%d").to_string(), "2026-04-25");
        assert_eq!((local.hour(), local.minute()), (9, 0));
    }

    #[test]
    fn time_without_zone_is_local() {
        use chrono::{DateTime, Local};
        let (_, due) = parse_inline_due("call mum due:2026-04-25T15:30");
        let local = DateTime::parse_from_rfc3339(&due.unwrap()).unwrap().with_timezone(&Local);
        assert_eq!(local.format("%Y-%m-%dT%H:%M").to_string(), "2026-04-25T15:30");
    }

    #[test]
    fn fingerprint_matches_node() {
        // Reference values from src/db.ts's fingerprint() under Node.
        assert_eq!(fingerprint("  Call  the\tDentist "), "ae50ef35f8b6be0f");
        assert_eq!(fingerprint("call the dentist"), "ae50ef35f8b6be0f");
        assert_eq!(fingerprint("Buy café crème"), "0088f097e69857d9");
    }

    #[test]
    fn old_quickadd_fingerprints_are_recomputed_once() {
        let path = std::env::temp_dir().join(format!("stickyinc-test-{}.db", uuid::Uuid::new_v4()));
        let conn = open_db(&path).unwrap();
        conn.execute("DELETE FROM meta WHERE key = 'fingerprint_sha256'", []).unwrap();
        conn.execute(
            "INSERT INTO tasks (uuid, text, source, fingerprint) VALUES ('u1', 'Call the dentist', 'quickadd', 'old-hash')",
            [],
        )
        .unwrap();
        drop(conn);
        let conn = open_db(&path).unwrap();
        let fp: String = conn
            .query_row("SELECT fingerprint FROM tasks WHERE uuid = 'u1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(fp, "ae50ef35f8b6be0f");
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn provenance_columns_are_added_to_old_dbs_and_read() {
        let path = std::env::temp_dir().join(format!("stickyinc-test-{}.db", uuid::Uuid::new_v4()));
        // A tasks table from before provenance, with a task in it.
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT, text TEXT NOT NULL,
               created_at TEXT NOT NULL DEFAULT (datetime('now')), completed_at TEXT, due_at TEXT,
               source TEXT NOT NULL DEFAULT 'claude', fingerprint TEXT);
             INSERT INTO tasks (uuid, text) VALUES ('old', 'Old task');",
        )
        .unwrap();
        drop(conn);
        let conn = open_db(&path).unwrap();
        conn.execute(
            "INSERT INTO tasks (uuid, text, source_client, source_excerpt)
             VALUES ('new', 'Email Sarah', 'Claude Code', 'I need to email Sarah')",
            [],
        )
        .unwrap();
        let sql = format!("SELECT {TASK_COLS} FROM tasks WHERE uuid = ?");
        let old = conn.query_row(&sql, ["old"], task_from_row).unwrap();
        assert_eq!((old.source_client, old.source_excerpt), (None, None));
        let new = conn.query_row(&sql, ["new"], task_from_row).unwrap();
        assert_eq!(new.source_client.as_deref(), Some("Claude Code"));
        assert_eq!(new.source_excerpt.as_deref(), Some("I need to email Sarah"));
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn calendar_file_is_replaced_whole() {
        let dir = std::env::temp_dir().join(format!("stickyinc-cal-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("stickyinc.ics");
        write_atomically(&path, "old").unwrap();
        write_atomically(&path, "BEGIN:VCALENDAR").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "BEGIN:VCALENDAR");
        assert!(!path.with_extension("tmp").exists(), "no temp file left behind");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn first_event_on_a_device_is_lamport_one() {
        let path = std::env::temp_dir().join(format!("stickyinc-test-{}.db", uuid::Uuid::new_v4()));
        let conn = open_db(&path).unwrap();
        assert_eq!(next_lamport(&conn, "fresh-device").unwrap(), 1);
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn snooze_moves_the_due_time_and_logs_it() {
        let path = std::env::temp_dir().join(format!("stickyinc-test-{}.db", uuid::Uuid::new_v4()));
        let mut conn = open_db(&path).unwrap();
        conn.execute_batch(
            "INSERT INTO tasks (uuid, text, due_at, due_phrase) VALUES ('s1', 'Call the dentist', '2026-10-02T19:00:00Z', 'Friday 3pm');
             INSERT INTO tasks (uuid, text, due_at, completed_at) VALUES ('s2', 'Done already', '2026-10-02T19:00:00Z', datetime('now'));",
        )
        .unwrap();
        let id: i64 = conn.query_row("SELECT id FROM tasks WHERE uuid = 's1'", [], |r| r.get(0)).unwrap();
        snooze(&mut conn, id, "2026-10-02T16:00:00-04:00").unwrap();
        let (due, phrase): (String, Option<String>) = conn
            .query_row("SELECT due_at, due_phrase FROM tasks WHERE id = ?", [id], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!((due.as_str(), phrase), ("2026-10-02T20:00:00Z", None));
        let payload: String = conn
            .query_row("SELECT payload FROM task_events WHERE task_uuid = 's1' AND op = 'edit'", [], |r| r.get(0))
            .unwrap();
        assert!(payload.contains(r#""snoozed_from":"2026-10-02T19:00:00Z""#), "{payload}");

        let done: i64 = conn.query_row("SELECT id FROM tasks WHERE uuid = 's2'", [], |r| r.get(0)).unwrap();
        assert!(snooze(&mut conn, done, "2026-10-03T13:00:00Z").is_err(), "finished tasks aren't snoozed");
        assert!(snooze(&mut conn, id, "tomorrow").is_err(), "not RFC 3339");
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn unparseable_due_stays_in_text() {
        assert_eq!(
            parse_inline_due("pay rent due:tomorrow"),
            ("pay rent due:tomorrow".to_string(), None)
        );
        assert_eq!(parse_inline_due("no due here"), ("no due here".to_string(), None));
    }
}
