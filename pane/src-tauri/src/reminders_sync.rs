//! One-way sync to Apple Reminders (macOS), when turned on in Settings: every
//! open task becomes a reminder in a "StickyInc" list, updated when its text
//! or due time changes and ticked when the task is. Outbound only, so edits
//! made in Reminders stay there. task_external records each task's reminder
//! id and what it was last sent, so a sync never adds a reminder twice and
//! only sends what changed. Google Tasks would be another `provider`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::{open_db, DbPath};

pub const PROVIDER: &str = "apple-reminders";

/// What a reminder was last given, to tell whether it needs an update.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Sent {
    pub text: String,
    pub due_at: Option<String>,
    pub done: bool,
}

/// A task as the planner sees it, with its reminder if it has one.
#[derive(Debug)]
pub struct Row {
    pub uuid: String,
    pub text: String,
    pub due_at: Option<String>,
    pub done: bool,
    pub excerpt: Option<String>,
    pub reminder: Option<(String, Sent)>,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum Action {
    Create { uuid: String, name: String, body: String, due: Option<String> },
    Update { uuid: String, id: String, name: String, due: Option<String> },
    Complete { uuid: String, id: String },
}

/// What to send: a reminder for each open task without one, an update where
/// the text or due time changed since it was sent, and a tick for each task
/// finished since.
pub fn plan(rows: &[Row]) -> Vec<Action> {
    rows.iter()
        .filter_map(|r| match (&r.reminder, r.done) {
            (None, false) => Some(Action::Create {
                uuid: r.uuid.clone(),
                name: r.text.clone(),
                body: r.excerpt.as_ref().map(|e| format!("“{e}”")).unwrap_or_default(),
                due: r.due_at.clone(),
            }),
            (Some((id, sent)), false) if sent.text != r.text || sent.due_at != r.due_at => {
                Some(Action::Update {
                    uuid: r.uuid.clone(),
                    id: id.clone(),
                    name: r.text.clone(),
                    due: r.due_at.clone(),
                })
            }
            (Some((id, sent)), true) if !sent.done => {
                Some(Action::Complete { uuid: r.uuid.clone(), id: id.clone() })
            }
            _ => None,
        })
        .collect()
}

/// Open tasks, and finished ones whose reminder isn't ticked yet.
fn load_rows(conn: &Connection) -> rusqlite::Result<Vec<Row>> {
    let mut stmt = conn.prepare(
        "SELECT t.uuid, t.text, t.due_at, t.completed_at IS NOT NULL, t.source_excerpt,
                x.external_id, x.sent
         FROM tasks t
         LEFT JOIN task_external x ON x.task_uuid = t.uuid AND x.provider = ?1
         WHERE t.completed_at IS NULL
            OR (x.external_id IS NOT NULL AND json_extract(x.sent, '$.done') = 0)",
    )?;
    let rows = stmt.query_map([PROVIDER], |row| {
        let id: Option<String> = row.get(5)?;
        let sent: Option<String> = row.get(6)?;
        let reminder = id.zip(sent.and_then(|s| serde_json::from_str::<Sent>(&s).ok()));
        Ok(Row {
            uuid: row.get(0)?,
            text: row.get(1)?,
            due_at: row.get(2)?,
            done: row.get(3)?,
            excerpt: row.get(4)?,
            reminder,
        })
    })?;
    rows.collect()
}

/// One action's outcome from the script, in the same order as the actions:
/// the reminder id, or why it failed.
#[derive(Debug, Deserialize)]
pub struct Outcome {
    pub id: Option<String>,
    pub error: Option<String>,
}

/// Record what each action sent. A failed update or tick (the reminder was
/// deleted in Reminders, say) is recorded as sent too, so it isn't retried
/// every minute; a failed create is retried on the next sync.
fn record(conn: &Connection, rows: &[Row], actions: &[Action], outcomes: &[Outcome]) -> rusqlite::Result<()> {
    for (action, outcome) in actions.iter().zip(outcomes) {
        let uuid = match action {
            Action::Create { uuid, .. } | Action::Update { uuid, .. } | Action::Complete { uuid, .. } => uuid,
        };
        let Some(row) = rows.iter().find(|r| &r.uuid == uuid) else { continue };
        let sent = Sent { text: row.text.clone(), due_at: row.due_at.clone(), done: row.done };
        let sent = serde_json::to_string(&sent).unwrap_or_default();
        match action {
            Action::Create { .. } => {
                if let Some(id) = &outcome.id {
                    conn.execute(
                        "INSERT OR REPLACE INTO task_external (task_uuid, provider, external_id, sent)
                         VALUES (?1, ?2, ?3, ?4)",
                        rusqlite::params![uuid, PROVIDER, id, sent],
                    )?;
                }
            }
            Action::Update { .. } | Action::Complete { .. } => {
                conn.execute(
                    "UPDATE task_external SET sent = ?3 WHERE task_uuid = ?1 AND provider = ?2",
                    rusqlite::params![uuid, PROVIDER, sent],
                )?;
            }
        }
    }
    Ok(())
}

/// JavaScript for Automation: dates from ISO strings without AppleScript's
/// locale-dependent parsing, and the actions arrive as JSON, so no task
/// text is ever spliced into the script.
#[cfg(target_os = "macos")]
const SCRIPT: &str = r#"
function run(argv) {
  const actions = JSON.parse(argv[0]);
  const app = Application("Reminders");
  const found = app.lists.whose({ name: "StickyInc" });
  let list;
  if (found.length > 0) {
    list = found[0];
  } else {
    list = app.List({ name: "StickyInc" });
    app.lists.push(list);
  }
  return JSON.stringify(actions.map((a) => {
    try {
      if (a.op === "create") {
        const props = { name: a.name, body: a.body };
        if (a.due) props.dueDate = new Date(a.due);
        const r = app.Reminder(props);
        list.reminders.push(r);
        return { uuid: a.uuid, id: r.id() };
      }
      const r = list.reminders.byId(a.id);
      if (a.op === "update") {
        r.name = a.name;
        if (a.due) r.dueDate = new Date(a.due);
      } else {
        r.completed = true;
      }
      return { uuid: a.uuid, id: a.id };
    } catch (e) {
      return { uuid: a.uuid, error: String(e) };
    }
  }));
}
"#;

#[cfg(target_os = "macos")]
fn run_script(actions: &[Action]) -> Result<Vec<Outcome>, String> {
    let input = serde_json::to_string(actions).map_err(|e| e.to_string())?;
    let out = std::process::Command::new("osascript")
        .args(["-l", "JavaScript", "-e", SCRIPT, &input])
        .output()
        .map_err(|e| format!("couldn't run osascript: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.contains("-1743") || err.contains("Not authorized") {
            "StickyInc isn't allowed to use Reminders. Allow it in System Settings → Privacy & Security → Automation.".into()
        } else {
            format!("Reminders: {err}")
        });
    }
    serde_json::from_slice(&out.stdout).map_err(|e| format!("Reminders sent back something unexpected: {e}"))
}

#[cfg(not(target_os = "macos"))]
fn run_script(_actions: &[Action]) -> Result<Vec<Outcome>, String> {
    Err("Apple Reminders sync is only on macOS.".into())
}

#[derive(Debug, Serialize)]
pub struct Report {
    pub created: usize,
    pub updated: usize,
    pub completed: usize,
    pub failed: Vec<String>,
}

fn sync(conn: &Connection) -> Result<Report, String> {
    let rows = load_rows(conn).map_err(|e| e.to_string())?;
    let actions = plan(&rows);
    let mut report = Report { created: 0, updated: 0, completed: 0, failed: vec![] };
    if actions.is_empty() {
        return Ok(report); // nothing changed: don't start osascript at all
    }
    let outcomes = run_script(&actions)?;
    record(conn, &rows, &actions, &outcomes).map_err(|e| e.to_string())?;
    for (action, outcome) in actions.iter().zip(&outcomes) {
        match (&outcome.error, action) {
            (Some(e), _) => report.failed.push(e.clone()),
            (None, Action::Create { .. }) => report.created += 1,
            (None, Action::Update { .. }) => report.updated += 1,
            (None, Action::Complete { .. }) => report.completed += 1,
        }
    }
    Ok(report)
}

static SYNCING: AtomicBool = AtomicBool::new(false);

/// Called every minute by the pane, and by Settings when it's turned on.
/// Does nothing unless it's on; one sync at a time.
#[tauri::command]
pub async fn sync_reminders(db: tauri::State<'_, Mutex<DbPath>>) -> Result<Report, String> {
    if !crate::wizard::reminders_sync_enabled() {
        return Ok(Report { created: 0, updated: 0, completed: 0, failed: vec![] });
    }
    if SYNCING.swap(true, Ordering::SeqCst) {
        return Err("A sync is already running.".into());
    }
    let path = db.lock().unwrap().0.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db(&path).map_err(|e| e.to_string())?;
        sync(&conn)
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|r| r);
    SYNCING.store(false, Ordering::SeqCst);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(uuid: &str, text: &str, due: Option<&str>, done: bool, sent: Option<Sent>) -> Row {
        Row {
            uuid: uuid.into(),
            text: text.into(),
            due_at: due.map(Into::into),
            done,
            excerpt: Some("I need to call the dentist".into()),
            reminder: sent.map(|s| (format!("x-apple-reminder://{uuid}"), s)),
        }
    }
    fn sent(text: &str, due: Option<&str>, done: bool) -> Option<Sent> {
        Some(Sent { text: text.into(), due_at: due.map(Into::into), done })
    }

    #[test]
    fn plans_creates_updates_and_ticks_but_nothing_unchanged() {
        let due = Some("2026-10-02T19:00:00Z");
        let rows = [
            row("new", "Call the dentist", due, false, None),
            row("same", "Buy bread", None, false, sent("Buy bread", None, false)),
            row("moved", "Email Sarah", Some("2026-10-03T13:00:00Z"), false, sent("Email Sarah", due, false)),
            row("renamed", "Renew passport now", None, false, sent("Renew passport", None, false)),
            row("finished", "Pay rent", None, true, sent("Pay rent", None, false)),
            row("ticked", "Old", None, true, sent("Old", None, true)),
        ];
        let planned = plan(&rows);
        let ops: Vec<(&str, &str)> = planned
            .iter()
            .map(|a| match a {
                Action::Create { uuid, .. } => ("create", uuid.as_str()),
                Action::Update { uuid, .. } => ("update", uuid.as_str()),
                Action::Complete { uuid, .. } => ("complete", uuid.as_str()),
            })
            .collect();
        assert_eq!(ops, [("create", "new"), ("update", "moved"), ("update", "renamed"), ("complete", "finished")]);
        match &plan(&rows[..1])[0] {
            Action::Create { body, due, .. } => {
                assert_eq!(body, "“I need to call the dentist”");
                assert_eq!(due.as_deref(), Some("2026-10-02T19:00:00Z"));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_synced_task_is_not_sent_again() {
        let path = std::env::temp_dir().join(format!("stickyinc-test-{}.db", uuid::Uuid::new_v4()));
        let conn = open_db(&path).unwrap();
        conn.execute_batch(
            "INSERT INTO tasks (uuid, text) VALUES ('a', 'Call the dentist');
             INSERT INTO tasks (uuid, text, completed_at) VALUES ('b', 'Done before sync', datetime('now'));",
        )
        .unwrap();
        let rows = load_rows(&conn).unwrap();
        assert_eq!(rows.len(), 1, "finished tasks never sent aren't picked up");
        let actions = plan(&rows);
        let outcomes = [Outcome { id: Some("rem-1".into()), error: None }];
        record(&conn, &rows, &actions, &outcomes).unwrap();
        assert!(plan(&load_rows(&conn).unwrap()).is_empty(), "nothing changed, nothing to send");

        conn.execute("UPDATE tasks SET completed_at = datetime('now') WHERE uuid = 'a'", []).unwrap();
        let rows = load_rows(&conn).unwrap();
        let actions = plan(&rows);
        assert_eq!(actions, [Action::Complete { uuid: "a".into(), id: "rem-1".into() }]);
        let outcomes = [Outcome { id: Some("rem-1".into()), error: None }];
        record(&conn, &rows, &actions, &outcomes).unwrap();
        assert!(load_rows(&conn).unwrap().is_empty(), "ticked in Reminders, so no longer loaded");
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }
}
