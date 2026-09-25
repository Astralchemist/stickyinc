//! Runs the passive watcher (the bundled `stickyinc-watch`) as a child
//! process while `watcher_enabled` is set in ~/.stickyinc/setup.json.

use std::fs::File;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use crate::wizard::{node_and_bundled_script, watcher_enabled, watcher_log_path};

#[derive(Default)]
pub struct PassiveWatcher(Mutex<Option<Child>>);

impl PassiveWatcher {
    /// Start the watcher if it's enabled and not running, or stop it if it's
    /// running and no longer enabled. Its output goes to
    /// ~/.stickyinc/watcher.log (truncated at each start).
    pub fn sync(&self, app: &tauri::AppHandle) -> Result<(), String> {
        let mut slot = self.0.lock().unwrap();
        // Forget a watcher that already exited (e.g. no LLM configured; the
        // reason is in the log).
        if let Some(child) = slot.as_mut() {
            if !matches!(child.try_wait(), Ok(None)) {
                *slot = None;
            }
        }
        match (watcher_enabled(), slot.is_some()) {
            (true, false) => *slot = Some(spawn(app)?),
            (false, true) => stop(slot.take()),
            _ => {}
        }
        Ok(())
    }

    pub fn stop(&self) {
        stop(self.0.lock().unwrap().take());
    }
}

fn spawn(app: &tauri::AppHandle) -> Result<Child, String> {
    let (node, script) = node_and_bundled_script(app, "mcp/stickyinc-watch.mjs")?;
    let log = File::create(watcher_log_path()).map_err(|e| e.to_string())?;
    let log_err = log.try_clone().map_err(|e| e.to_string())?;
    Command::new(node)
        .arg(script)
        // Exits on its own if the pane dies without stopping it.
        .arg("--exit-with-parent")
        .stdin(Stdio::null())
        .stdout(log)
        .stderr(log_err)
        .spawn()
        .map_err(|e| format!("couldn't start the passive watcher: {e}"))
}

fn stop(child: Option<Child>) {
    if let Some(mut child) = child {
        let _ = child.kill();
        let _ = child.wait();
    }
}
