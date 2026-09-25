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

/// Read `~/.claude.json` for a read-modify-write. Unlike `read_json`, anything
/// other than "file doesn't exist" is an error: that file is Claude Code's
/// whole config, and treating an unreadable or half-written copy as `{}`
/// would overwrite it with just our entry.
fn read_claude_config(path: &PathBuf) -> Result<serde_json::Value, String> {
    let raw = match fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(serde_json::json!({})),
        Err(e) => return Err(format!("Couldn't read {}: {}", path.display(), e)),
    };
    let cfg: serde_json::Value = serde_json::from_str(&raw).map_err(|e| {
        format!(
            "{} isn't valid JSON ({}). Leaving it untouched — if Claude Code is running, \
             try again in a moment.",
            path.display(),
            e
        )
    })?;
    if !cfg.is_object() {
        return Err(format!("{} isn't a JSON object; leaving it untouched.", path.display()));
    }
    Ok(cfg)
}

/// Write JSON with 0600 permissions, atomically: render to a temp file beside
/// the target, then rename over it, so other readers (Claude Code for
/// `~/.claude.json`) never see a truncated file and secrets are never briefly
/// world-readable. Symlinks are followed so dotfile-managed configs stay linked.
fn write_json_secure(path: &PathBuf, value: &serde_json::Value) -> std::io::Result<()> {
    use std::io::Write;

    let rendered = serde_json::to_string_pretty(value).unwrap_or_else(|_| "{}".to_string());
    let target = fs::canonicalize(path).unwrap_or_else(|_| path.clone());
    let mut tmp = target.clone().into_os_string();
    tmp.push(".stickyinc-tmp");
    let tmp = PathBuf::from(tmp);
    let _ = fs::remove_file(&tmp);

    let mut opts = fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let written = opts.open(&tmp).and_then(|mut f| {
        f.write_all(rendered.as_bytes())?;
        f.sync_all()
    });
    if let Err(e) = written.and_then(|_| fs::rename(&tmp, &target)) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
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
/// `codex`, `gemini`, or even `node`. After the PATH walk we check the usual
/// install dirs, then (macOS) ask the user's own shell. Mirrors
/// `whichBinary` in src/providers/which.ts.
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

    #[cfg(unix)]
    if let Some(home) = dirs::home_dir() {
        let known = [
            home.join(".local/bin"), // Claude Code's native installer, codex, pipx, uv
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
            home.join(".npm-global/bin"),
            home.join(".volta/bin"),
            home.join(".bun/bin"),
        ];
        for dir in known {
            let candidate = dir.join(name);
            if candidate.exists() {
                return Some(candidate.to_string_lossy().to_string());
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        return shell_resolve(name);
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

/// Ask the user's own shell, as a login + interactive shell: that is what
/// reads ~/.zprofile and ~/.zshrc, where Homebrew, nvm, asdf and installers
/// add to PATH. (`/bin/sh -l` reads neither.) Killed after 3s so a slow or
/// odd rc file can't hang setup.
#[cfg(target_os = "macos")]
fn shell_resolve(name: &str) -> Option<String> {
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return None;
    }
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let mut child = Command::new(shell)
        .arg("-ilc")
        .arg(format!("command -v {}", name))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    // Interactive rc files can print banners; the answer is the last line
    // that is an existing absolute path (aliases and functions don't count).
    out.lines()
        .rev()
        .map(str::trim)
        .find(|l| l.starts_with('/') && std::path::Path::new(l).exists())
        .map(str::to_string)
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

const NODE_REQUIRED: &str =
    "Node.js 22.13+ required — install from https://nodejs.org and re-run setup.";

/// `node --version` as (major, minor), or None if it can't be run or parsed.
fn node_version(node: &str) -> Option<(u32, u32)> {
    let out = std::process::Command::new(node)
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .output()
        .ok()?;
    let v = String::from_utf8_lossy(&out.stdout);
    let mut parts = v.trim().trim_start_matches('v').split('.');
    Some((parts.next()?.parse().ok()?, parts.next()?.parse().ok()?))
}

/// The bundled server uses `node:sqlite`, available without a flag from
/// Node 22.13 and 23.4.
fn node_has_sqlite((major, minor): (u32, u32)) -> bool {
    match major {
        22 => minor >= 13,
        23 => minor >= 4,
        m => m >= 24,
    }
}

/// Resolve the MCP server command we'll register in `~/.claude.json`.
///
/// The server ships inside the app as one self-contained file
/// (`pnpm bundle` → `mcp/stickyinc-mcp.mjs`, mapped in tauri.conf.json under
/// `bundle.resources`); `tauri dev` copies it next to the debug binary too.
///
/// Errors out if the bundle is missing or `node` is absent or too old —
/// registering the entry would silently fail at runtime otherwise, which is
/// the v0.5.1 "subscription mode doesn't work" bug.
fn mcp_default_command(app: &tauri::AppHandle) -> Result<(String, Vec<String>), String> {
    let node = resolve_binary("node").ok_or_else(|| NODE_REQUIRED.to_string())?;
    match node_version(&node) {
        Some(v) if node_has_sqlite(v) => {}
        Some((major, minor)) => {
            return Err(format!("{} (found v{}.{} at {})", NODE_REQUIRED, major, minor, node))
        }
        None => return Err(format!("{} (couldn't run {} --version)", NODE_REQUIRED, node)),
    }

    let mcp_path = app
        .path()
        .resolve("mcp/stickyinc-mcp.mjs", BaseDirectory::Resource)
        .ok()
        .filter(|p| p.exists())
        .ok_or_else(|| {
            "StickyInc's bundled MCP server is missing from this install — reinstall the app."
                .to_string()
        })?;
    Ok((node, vec![mcp_path.to_string_lossy().to_string()]))
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
    let cfg = read_claude_config(&path)?;
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
    let mut cfg = read_claude_config(&path)?;
    let root = cfg.as_object_mut().ok_or("~/.claude.json is not an object")?;
    let servers = root
        .entry("mcpServers".to_string())
        .or_insert(serde_json::json!({}))
        .as_object_mut()
        .ok_or("\"mcpServers\" in ~/.claude.json isn't an object; leaving it untouched.")?;
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
        "openrouter" => validate_openai_compat(&client, &cfg, "https://openrouter.ai/api/v1", "anthropic/claude-haiku-4.5").await,
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
    cfg["completed_at"] = serde_json::Value::String(chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string());
    cfg["version"] = serde_json::json!("0.5.1");
    write_json_secure(&setup_sentinel_path(), &cfg).map_err(|e| e.to_string())?;
    // Tell the main pane window to flip out of hidden/bulge mode and show the strip.
    let _ = app.emit("setup-complete", ());
    Ok(())
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
