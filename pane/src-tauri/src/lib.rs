use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

#[derive(Debug, Serialize, Clone)]
pub struct Task {
    pub id: i64,
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
    conn.execute_batch(
        r#"
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
        "#,
    )?;
    Ok(conn)
}

#[tauri::command]
fn list_open_tasks(db: tauri::State<'_, Mutex<DbPath>>) -> Result<Vec<Task>, String> {
    let path = db.lock().unwrap().0.clone();
    let conn = open_db(&path).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, text, created_at, completed_at, due_at, source
             FROM tasks
             WHERE completed_at IS NULL
             ORDER BY CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at ASC, created_at ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(Task {
                id: row.get(0)?,
                text: row.get(1)?,
                created_at: row.get(2)?,
                completed_at: row.get(3)?,
                due_at: row.get(4)?,
                source: row.get(5)?,
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
            "SELECT id, text, created_at, completed_at, due_at, source
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
                text: row.get(1)?,
                created_at: row.get(2)?,
                completed_at: row.get(3)?,
                due_at: row.get(4)?,
                source: row.get(5)?,
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
            "SELECT id, text, created_at, completed_at, due_at, source
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
                text: row.get(1)?,
                created_at: row.get(2)?,
                completed_at: row.get(3)?,
                due_at: row.get(4)?,
                source: row.get(5)?,
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
    let conn = open_db(&path).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO tasks (text, due_at, source, fingerprint) VALUES (?, ?, 'quickadd', ?)",
        rusqlite::params![
            task_text,
            due_at,
            fingerprint(&task_text),
        ],
    )
    .map_err(|e| e.to_string())?;
    let id = conn.last_insert_rowid();
    let task = conn
        .query_row(
            "SELECT id, text, created_at, completed_at, due_at, source FROM tasks WHERE id = ?",
            [id],
            |row| {
                Ok(Task {
                    id: row.get(0)?,
                    text: row.get(1)?,
                    created_at: row.get(2)?,
                    completed_at: row.get(3)?,
                    due_at: row.get(4)?,
                    source: row.get(5)?,
                })
            },
        )
        .map_err(|e| e.to_string())?;
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
    let conn = open_db(&path).map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE tasks SET completed_at = datetime('now') WHERE id = ? AND completed_at IS NULL",
        [id],
    )
    .map_err(|e| e.to_string())?;
    let task = conn
        .query_row(
            "SELECT id, text, created_at, completed_at, due_at, source FROM tasks WHERE id = ?",
            [id],
            |row| {
                Ok(Task {
                    id: row.get(0)?,
                    text: row.get(1)?,
                    created_at: row.get(2)?,
                    completed_at: row.get(3)?,
                    due_at: row.get(4)?,
                    source: row.get(5)?,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(task)
}

#[tauri::command]
fn close_quickadd(window: tauri::Window) -> Result<(), String> {
    if window.label() == "quickadd" {
        window.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let path = db_path();
    // Ensure schema exists before watcher fires.
    open_db(&path).expect("init db");

    tauri::Builder::default()
        .manage(Mutex::new(DbPath(path.clone())))
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
            close_quickadd
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
