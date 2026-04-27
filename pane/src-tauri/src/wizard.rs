use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::path::BaseDirectory;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

fn stickyinc_dir() -> PathBuf {
    let mut p = dirs::home_dir().expect("no home dir");
    p.push(".stickyinc");
    let _ = fs::create_dir_all(&p);
    p
}

fn claude_config_path() -> PathBuf {
    let mut p = dirs::home_dir().expect("no home dir");
    p.push(".claude.json");
    p
}

fn llm_config_path() -> PathBuf {
    stickyinc_dir().join("llm.json")
}

fn setup_sentinel_path() -> PathBuf {
    stickyinc_dir().join("setup.json")
}

fn read_json(path: &PathBuf) -> serde_json::Value {
    match fs::read_to_string(path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or(serde_json::json!({})),
        Err(_) => serde_json::json!({}),
    }
}

fn write_json_secure(path: &PathBuf, value: &serde_json::Value) -> std::io::Result<()> {
    let rendered = serde_json::to_string_pretty(value).unwrap_or_else(|_| "{}".to_string());
    fs::write(path, rendered)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(path)?.permissions();
        perms.set_mode(0o600);
        let _ = fs::set_permissions(path, perms);
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LLMConfig {
    pub provider: String,
    pub api_key: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub model: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ValidateResult {
    pub ok: bool,
    pub model: String,
    pub detail: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ClaudeDiff {
    pub state: String,
    pub existing: Option<serde_json::Value>,
    pub proposed: serde_json::Value,
    pub pretty: String,
}

#[derive(Debug, Serialize)]
pub struct DetectedLocal {
    pub kind: String, // "ollama" | "lm-studio"
    pub url: String,
    pub first_model: String,
}

#[derive(Debug, Serialize)]
pub struct SubscriptionDetection {
    pub claude_code: bool,
    pub codex: bool,
    pub gemini: bool,
    pub local: Option<DetectedLocal>,
}

/// Resolve `name` to an absolute path, returning `None` if it isn't installed.
///
/// Apps launched from Finder/Dock/Spotlight on macOS inherit a stripped PATH
/// (`/usr/bin:/bin:/usr/sbin:/sbin`) that doesn't include the user's npm /
/// Homebrew / asdf / volta dirs — so a plain PATH walk can't see `claude`,
/// `codex`, `gemini`, or even `node` for users who installed them via tools
/// other than the system package manager. The fallback shells out to
/// `/bin/sh -lc 'command -v <name>'` so a real login shell sources the user's
/// rc files and tells us where the binary actually lives.
fn resolve_binary(name: &str) -> Option<String> {
    if let Some(path) = std::env::var_os("PATH") {
        let exts: &[&str] = if cfg!(windows) {
            &[".exe", ".cmd", ".bat", ""]
        } else {
            &[""]
        };
        for dir in std::env::split_paths(&path) {
            if dir.as_os_str().is_empty() {
                continue;
            }
            for ext in exts {
                let candidate = dir.join(format!("{}{}", name, ext));
                if candidate.exists() {
                    return Some(candidate.to_string_lossy().to_string());
                }
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        return shell_resolve(name);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = name;
        None
    }
}

#[cfg(target_os = "macos")]
fn shell_resolve(name: &str) -> Option<String> {
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return None;
    }
    use std::process::{Command, Stdio};
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    let (tx, rx) = mpsc::channel();
    let cmd_str = format!("command -v {}", name);
    thread::spawn(move || {
        let result = Command::new("/bin/sh")
            .arg("-lc")
            .arg(cmd_str)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output();
        let _ = tx.send(result);
    });
    match rx.recv_timeout(Duration::from_secs(1)) {
        Ok(Ok(out)) if out.status.success() => {
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if s.is_empty() {
                None
            } else {
                Some(s)
            }
        }
        _ => None,
    }
}

async fn probe_local_endpoint(
    client: &reqwest::Client,
    url: &str,
    kind: &str,
) -> Option<DetectedLocal> {
    if kind == "ollama" {
        let res = client.get(format!("{}/api/tags", url)).send().await.ok()?;
        if !res.status().is_success() {
            return None;
        }
        let data: serde_json::Value = res.json().await.ok()?;
        let first = data
            .get("models")
            .and_then(|m| m.as_array())
            .and_then(|a| a.first())
            .and_then(|m| m.get("name"))
            .and_then(|n| n.as_str())?;
        Some(DetectedLocal {
            kind: kind.to_string(),
            url: url.to_string(),
            first_model: first.to_string(),
        })
    } else {
        let res = client.get(format!("{}/v1/models", url)).send().await.ok()?;
        if !res.status().is_success() {
            return None;
        }
        let data: serde_json::Value = res.json().await.ok()?;
        let first = data
            .get("data")
            .and_then(|d| d.as_array())
            .and_then(|a| a.first())
            .and_then(|m| m.get("id"))
            .and_then(|n| n.as_str())?;
        Some(DetectedLocal {
            kind: kind.to_string(),
            url: url.to_string(),
            first_model: first.to_string(),
        })
    }
}

#[tauri::command]
pub async fn wizard_detect_subscriptions() -> SubscriptionDetection {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(600))
        .build()
        .ok();
    let local = if let Some(c) = client {
        if let Some(d) = probe_local_endpoint(&c, "http://127.0.0.1:11434", "ollama").await {
            Some(d)
        } else {
            probe_local_endpoint(&c, "http://127.0.0.1:1234", "lm-studio").await
        }
    } else {
        None
    };
    SubscriptionDetection {
        claude_code: resolve_binary("claude").is_some(),
        codex: resolve_binary("codex").is_some(),
        gemini: resolve_binary("gemini").is_some(),
        local,
    }
}

/// Resolve the MCP server command we'll register in `~/.claude.json`.
///
/// Production builds bundle the Node MCP entry as a Tauri resource (configured
/// in tauri.conf.json under `bundle.resources`); we resolve that path through
/// the AppHandle. Dev builds fall back to `~/stickyinc/dist/index.js`, which
/// is the path users running from a clone already have.
///
/// Errors out if `node` itself isn't installed — registering the entry would
/// silently fail at runtime otherwise, which is the v0.5.1 "subscription mode
/// doesn't work" bug.
fn mcp_default_command(app: &tauri::AppHandle) -> Result<(String, Vec<String>), String> {
    let node = resolve_binary("node").ok_or_else(|| {
        "Node.js 20+ required — install from https://nodejs.org and re-run setup.".to_string()
    })?;

    let bundled = app
        .path()
        .resolve("dist/index.js", BaseDirectory::Resource)
        .ok()
        .filter(|p| p.exists());
    let mcp_path = match bundled {
        Some(p) => p.to_string_lossy().to_string(),
        None => {
            let home = dirs::home_dir().unwrap_or_default();
            home.join("stickyinc")
                .join("dist")
                .join("index.js")
                .to_string_lossy()
                .to_string()
        }
    };
    Ok((node, vec![mcp_path]))
}

fn mcp_proposed_entry(app: &tauri::AppHandle) -> Result<serde_json::Value, String> {
    let (cmd, args) = mcp_default_command(app)?;
    Ok(serde_json::json!({ "command": cmd, "args": args }))
}

fn render_pretty_diff(state: &str, existing: Option<&serde_json::Value>, proposed: &serde_json::Value) -> String {
    let proposed_pretty = serde_json::to_string_pretty(&serde_json::json!({
        "mcpServers": { "stickyinc": proposed }
    })).unwrap_or_default();
    match state {
        "new" => proposed_pretty
            .lines()
            .map(|l| format!("<span class=\"add\">+ {}</span>", html_escape(l)))
            .collect::<Vec<_>>()
            .join("\n"),
        "same" => proposed_pretty
            .lines()
            .map(|l| format!("  {}", html_escape(l)))
            .collect::<Vec<_>>()
            .join("\n"),
        "conflict" => {
            let existing_pretty = serde_json::to_string_pretty(&serde_json::json!({
                "mcpServers": { "stickyinc": existing.cloned().unwrap_or(serde_json::Value::Null) }
            })).unwrap_or_default();
            let del = existing_pretty
                .lines()
                .map(|l| format!("<span class=\"del\">- {}</span>", html_escape(l)))
                .collect::<Vec<_>>()
                .join("\n");
            let add = proposed_pretty
                .lines()
                .map(|l| format!("<span class=\"add\">+ {}</span>", html_escape(l)))
                .collect::<Vec<_>>()
                .join("\n");
            format!("{}\n{}", del, add)
        }
        _ => proposed_pretty,
    }
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

#[tauri::command]
pub fn wizard_diff_claude_json(app: tauri::AppHandle) -> Result<ClaudeDiff, String> {
    let path = claude_config_path();
    let proposed = mcp_proposed_entry(&app)?;
    let cfg = read_json(&path);
    let existing = cfg
        .get("mcpServers")
        .and_then(|m| m.get("stickyinc"))
        .cloned();

    let state = match &existing {
        None => "new",
        Some(v) if v == &proposed => "same",
        Some(_) => "conflict",
    };

    Ok(ClaudeDiff {
        state: state.to_string(),
        pretty: render_pretty_diff(state, existing.as_ref(), &proposed),
        existing,
        proposed,
    })
}

#[tauri::command]
pub fn wizard_register_mcp(app: tauri::AppHandle, resolution: String) -> Result<(), String> {
    if resolution == "skip" {
        return Ok(());
    }
    let proposed = mcp_proposed_entry(&app)?;
    let path = claude_config_path();
    let mut cfg = read_json(&path);
    if !cfg.is_object() {
        cfg = serde_json::json!({});
    }
    let root = cfg.as_object_mut().ok_or("~/.claude.json is not an object")?;
    let servers = root
        .entry("mcpServers".to_string())
        .or_insert(serde_json::json!({}));
    if !servers.is_object() {
        *servers = serde_json::json!({});
    }
    let servers = servers.as_object_mut().unwrap();
    servers.insert("stickyinc".to_string(), proposed);
    write_json_secure(&path, &cfg).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn wizard_read_llm_config() -> Result<Option<LLMConfig>, String> {
    let path = llm_config_path();
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let cfg: LLMConfig = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    Ok(Some(cfg))
}

#[tauri::command]
pub fn wizard_save_llm_config(cfg: LLMConfig) -> Result<(), String> {
    let val = serde_json::to_value(&cfg).map_err(|e| e.to_string())?;
    write_json_secure(&llm_config_path(), &val).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn wizard_validate_llm_key(cfg: LLMConfig) -> Result<ValidateResult, String> {
    if cfg.api_key.trim().is_empty() {
        return Ok(ValidateResult {
            ok: false,
            model: String::new(),
            detail: Some("API key is empty.".to_string()),
        });
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;

    match cfg.provider.as_str() {
        "anthropic" => validate_anthropic(&client, &cfg).await,
        "openrouter" => validate_openai_compat(&client, &cfg, "https://openrouter.ai/api/v1", "anthropic/claude-3.5-haiku").await,
        "openai" => validate_openai_compat(&client, &cfg, "https://api.openai.com/v1", "gpt-4o-mini").await,
        "compat" => {
            let base = cfg.base_url.clone().ok_or("Base URL required for compat provider")?;
            let model = cfg.model.clone().unwrap_or_else(|| "gpt-4o-mini".to_string());
            let mut cfg2 = cfg.clone();
            cfg2.model = Some(model.clone());
            validate_openai_compat(&client, &cfg2, &base, &model).await
        }
        other => Err(format!("unknown provider: {}", other)),
    }
}

async fn validate_anthropic(client: &reqwest::Client, cfg: &LLMConfig) -> Result<ValidateResult, String> {
    let model = cfg.model.clone().unwrap_or_else(|| "claude-haiku-4-5-20251001".to_string());
    let body = serde_json::json!({
        "model": model,
        "max_tokens": 1,
        "messages": [{"role": "user", "content": "."}]
    });
    let res = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", &cfg.api_key)
        .header("anthropic-version", "2023-06-01")
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if res.status().is_success() {
        let data: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
        let returned_model = data
            .get("model")
            .and_then(|v| v.as_str())
            .unwrap_or(&model)
            .to_string();
        Ok(ValidateResult { ok: true, model: returned_model, detail: None })
    } else {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        Ok(ValidateResult {
            ok: false,
            model: String::new(),
            detail: Some(format!("{}: {}", status, body.chars().take(300).collect::<String>())),
        })
    }
}

async fn validate_openai_compat(
    client: &reqwest::Client,
    cfg: &LLMConfig,
    base: &str,
    default_model: &str,
) -> Result<ValidateResult, String> {
    let model = cfg.model.clone().unwrap_or_else(|| default_model.to_string());
    let body = serde_json::json!({
        "model": model,
        "max_tokens": 1,
        "messages": [{"role": "user", "content": "."}]
    });
    let url = format!("{}/chat/completions", base.trim_end_matches('/'));
    let res = client
        .post(url)
        .bearer_auth(&cfg.api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if res.status().is_success() {
        let data: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
        let returned_model = data
            .get("model")
            .and_then(|v| v.as_str())
            .unwrap_or(&model)
            .to_string();
        Ok(ValidateResult { ok: true, model: returned_model, detail: None })
    } else {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        Ok(ValidateResult {
            ok: false,
            model: String::new(),
            detail: Some(format!("{}: {}", status, body.chars().take(300).collect::<String>())),
        })
    }
}

#[tauri::command]
pub fn wizard_set_watcher_enabled(enabled: bool) -> Result<(), String> {
    let mut cfg = read_json(&setup_sentinel_path());
    if !cfg.is_object() {
        cfg = serde_json::json!({});
    }
    cfg["watcher_enabled"] = serde_json::Value::Bool(enabled);
    write_json_secure(&setup_sentinel_path(), &cfg).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn wizard_mark_complete(app: tauri::AppHandle) -> Result<(), String> {
    let mut cfg = read_json(&setup_sentinel_path());
    if !cfg.is_object() {
        cfg = serde_json::json!({});
    }
    cfg["completed_at"] = serde_json::Value::String(chrono_like_now());
    cfg["version"] = serde_json::json!("0.5.1");
    write_json_secure(&setup_sentinel_path(), &cfg).map_err(|e| e.to_string())?;
    // Tell the main pane window to flip out of hidden/bulge mode and show the strip.
    let _ = app.emit("setup-complete", ());
    Ok(())
}

fn chrono_like_now() -> String {
    // Avoid pulling chrono just for this — format in UTC via std.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Simple YYYY-MM-DDTHH:MM:SSZ from epoch seconds.
    // Using a tiny conversion; good enough for a timestamp.
    let (year, month, day, hour, min, sec) = epoch_to_ymdhms(now);
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", year, month, day, hour, min, sec)
}

fn epoch_to_ymdhms(secs: u64) -> (i64, u32, u32, u32, u32, u32) {
    let days = (secs / 86400) as i64;
    let sec_of_day = (secs % 86400) as u32;
    let hour = sec_of_day / 3600;
    let min = (sec_of_day % 3600) / 60;
    let sec = sec_of_day % 60;

    // Algorithm from Howard Hinnant's days_from_civil, adapted.
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = (z - era * 146097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };
    (year, month, day, hour, min, sec)
}

pub fn setup_is_complete() -> bool {
    let cfg = read_json(&setup_sentinel_path());
    cfg.get("completed_at").is_some()
}

pub fn open_wizard_window(app: &tauri::AppHandle) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window("wizard") {
        let _ = w.show();
        let _ = w.set_focus();
        let _ = w.center();
        return Ok(());
    }
    let win = WebviewWindowBuilder::new(app, "wizard", WebviewUrl::App("wizard.html".into()))
        .title("StickyInc — Setup")
        .inner_size(560.0, 520.0)
        .decorations(false)
        .transparent(true)
        .always_on_top(false)
        .resizable(false)
        .skip_taskbar(false)
        .focused(true)
        .center()
        .build()?;
    let _ = win.show();
    let _ = win.set_focus();
    Ok(())
}

#[tauri::command]
pub fn open_wizard(app: tauri::AppHandle) -> Result<(), String> {
    open_wizard_window(&app).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn wizard_close(window: tauri::Window) -> Result<(), String> {
    if window.label() == "wizard" {
        window.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}
