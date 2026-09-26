//! The browser clipper's way in. The StickyInc extension posts here when you
//! right-click a page → Stack on StickyInc → Read / Reply / Review / Decide.
//! A clip is a commitment about the page, not a bookmark: a task ("Reply to
//! “Q3 budget thread”") with the URL, your selection and the browser as its
//! provenance, in the same database, so due dates, reminders, the calendar
//! file, Reminders sync and sticky_search all cover it. No new sync path.
//!
//! Bound to 127.0.0.1 only. Every request needs the pairing code made on
//! first run (~/.stickyinc/clip-token, shown in Settings), so a web page
//! can't add tasks by posting here; requests carrying a web page's Origin
//! are refused as well.

use std::io::Read;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Duration as ChronoDuration, Local, TimeZone, Utc};
use rusqlite::{Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::json;

use crate::{fingerprint, insert_task, open_db, task_from_row, TASK_COLS};

/// The extension's host_permissions name this port.
pub const PORT: u16 = 47827;
const MAX_BODY: usize = 16 * 1024;
const EXCERPT_MAX: usize = 200;

pub fn token_path() -> PathBuf {
    crate::db_path().with_file_name("clip-token")
}

/// The pairing code, made (random, readable only by this user) on first use.
pub fn load_or_create_token(path: &Path) -> std::io::Result<String> {
    if let Ok(t) = std::fs::read_to_string(path) {
        let t = t.trim().to_string();
        if t.len() >= 32 {
            return Ok(t);
        }
    }
    let token = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    use std::io::Write;
    opts.open(path)?.write_all(token.as_bytes())?;
    Ok(token)
}

#[derive(Debug, Deserialize)]
struct ClipRequest {
    url: String,
    title: Option<String>,
    excerpt: Option<String>,
    intent: String,
    browser: Option<String>,
}

#[derive(Debug, PartialEq)]
pub struct Response {
    pub status: u16,
    pub body: serde_json::Value,
}

fn reply(status: u16, body: serde_json::Value) -> Response {
    Response { status, body }
}

/// Compare without stopping at the first difference, so timing doesn't leak the code.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Whitespace collapsed, cut to `max` characters with an ellipsis; None if empty.
fn cap(s: Option<&str>, max: usize) -> Option<String> {
    let flat = s?.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.is_empty() {
        return None;
    }
    let chars: Vec<char> = flat.chars().collect();
    Some(if chars.len() <= max {
        flat
    } else {
        format!("{}…", chars[..max - 1].iter().collect::<String>().trim_end())
    })
}

/// Tomorrow at 09:00 local, as UTC ISO 8601: a Reply's default due time.
fn tomorrow_morning(now: DateTime<Local>) -> String {
    let date = now.date_naive() + ChronoDuration::days(1);
    let local = Local
        .from_local_datetime(&date.and_hms_opt(9, 0, 0).unwrap())
        .earliest()
        .unwrap_or(now + ChronoDuration::days(1));
    local.with_timezone(&Utc).format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

/// One request, from its parts: the endpoint without the HTTP server, so
/// it can be tested directly.
pub fn handle(
    method: &str,
    path: &str,
    authorization: Option<&str>,
    origin: Option<&str>,
    body: &[u8],
    conn: &mut Connection,
    token: &str,
    now: DateTime<Local>,
) -> Response {
    if let Some(o) = origin {
        let extension = ["chrome-extension://", "moz-extension://", "safari-web-extension://"];
        if !extension.iter().any(|p| o.starts_with(p)) {
            return reply(403, json!({ "error": "Only the StickyInc extension can add clips." }));
        }
    }
    let given = authorization.and_then(|a| a.strip_prefix("Bearer ")).unwrap_or("");
    if !same(given, token) {
        return reply(401, json!({ "error": "Pair the extension with the code from StickyInc → Settings → Browser clipper." }));
    }
    match (method, path) {
        ("GET", "/status") => reply(200, json!({ "ok": true })),
        ("POST", "/clip") => clip(body, conn, now),
        _ => reply(404, json!({ "error": "not found" })),
    }
}

fn clip(body: &[u8], conn: &mut Connection, now: DateTime<Local>) -> Response {
    let req: ClipRequest = match serde_json::from_slice(body) {
        Ok(r) => r,
        Err(e) => return reply(400, json!({ "error": format!("bad clip: {e}") })),
    };
    let url = req.url.trim();
    if !(url.starts_with("http://") || url.starts_with("https://")) || url.len() > 2048 {
        return reply(400, json!({ "error": "Only web pages (http or https) can be stacked." }));
    }
    let (verb, due_at) = match req.intent.as_str() {
        "read" => ("Read", None),
        "reply" => ("Reply to", Some(tomorrow_morning(now))),
        "review" => ("Review", None),
        "decide" => ("Decide on", None),
        other => return reply(400, json!({ "error": format!("unknown intent {other:?}") })),
    };
    let title = cap(req.title.as_deref(), 150).unwrap_or_else(|| {
        url.split("://").nth(1).unwrap_or(url).trim_end_matches('/').chars().take(150).collect()
    });
    let text = format!("{verb} “{title}”");
    let excerpt = cap(req.excerpt.as_deref(), EXCERPT_MAX);
    let browser = cap(req.browser.as_deref(), 40).unwrap_or_else(|| "your browser".into());

    let result = (|| -> rusqlite::Result<(crate::Task, bool)> {
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        // Stacking the same page for the same thing twice finds the first.
        let existing = tx
            .query_row(
                &format!("SELECT {TASK_COLS} FROM tasks WHERE fingerprint = ? AND completed_at IS NULL LIMIT 1"),
                [fingerprint(&text)],
                task_from_row,
            )
            .optional()?;
        if let Some(task) = existing {
            return Ok((task, false));
        }
        let source = format!("clip:{}", req.intent);
        let task = insert_task(
            &tx,
            &text,
            due_at.as_deref(),
            &source,
            (Some(browser.as_str()), Some(url), excerpt.as_deref()),
        )?;
        tx.commit()?;
        Ok((task, true))
    })();
    match result {
        Ok((task, created)) => reply(
            if created { 201 } else { 200 },
            json!({ "id": task.id, "text": task.text, "due_at": task.due_at, "duplicate": !created }),
        ),
        Err(e) => reply(500, json!({ "error": e.to_string() })),
    }
}

/// Serve on `addr` until the process ends. Called on a thread at startup;
/// if the port is taken, the clipper is just unavailable.
pub fn serve(addr: &str, db_path: PathBuf, token: String) {
    let server = match tiny_http::Server::http(addr) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("clipper endpoint on {addr}: {e}");
            return;
        }
    };
    for mut request in server.incoming_requests() {
        let header = |name: &str| {
            request
                .headers()
                .iter()
                .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name))
                .map(|h| h.value.as_str().to_string())
        };
        let (authorization, origin) = (header("Authorization"), header("Origin"));
        let method = request.method().as_str().to_string();
        let path = request.url().split('?').next().unwrap_or("").to_string();
        let mut body = Vec::new();
        let read = request.as_reader().take(MAX_BODY as u64 + 1).read_to_end(&mut body);
        let response = if read.is_err() {
            reply(400, json!({ "error": "couldn't read the request" }))
        } else if body.len() > MAX_BODY {
            reply(413, json!({ "error": "clip too large" }))
        } else {
            match open_db(&db_path) {
                Ok(mut conn) => handle(
                    &method,
                    &path,
                    authorization.as_deref(),
                    origin.as_deref(),
                    &body,
                    &mut conn,
                    &token,
                    Local::now(),
                ),
                Err(e) => reply(500, json!({ "error": e.to_string() })),
            }
        };
        let content_type = tiny_http::Header::from_bytes("Content-Type", "application/json").unwrap();
        let _ = request.respond(
            tiny_http::Response::from_string(response.body.to_string())
                .with_status_code(response.status)
                .with_header(content_type),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    const TOKEN: &str = "0123456789abcdef0123456789abcdef";

    fn temp_db() -> (PathBuf, Connection) {
        let path = std::env::temp_dir().join(format!("stickyinc-test-{}.db", uuid::Uuid::new_v4()));
        let conn = open_db(&path).unwrap();
        (path, conn)
    }
    fn fri_1030() -> DateTime<Local> {
        Local.with_ymd_and_hms(2026, 9, 25, 10, 30, 0).unwrap()
    }
    fn post(conn: &mut Connection, body: &str) -> Response {
        let auth = format!("Bearer {TOKEN}");
        handle("POST", "/clip", Some(&auth), Some("chrome-extension://abc"), body.as_bytes(), conn, TOKEN, fri_1030())
    }

    #[test]
    fn needs_the_pairing_code_and_an_extension_origin() {
        let (path, mut conn) = temp_db();
        let bearer = format!("Bearer {TOKEN}");
        let status = |auth: Option<&str>, origin: Option<&str>, conn: &mut Connection| {
            handle("GET", "/status", auth, origin, b"", conn, TOKEN, fri_1030()).status
        };
        assert_eq!(status(Some(&bearer), Some("chrome-extension://abc"), &mut conn), 200);
        assert_eq!(status(Some(&bearer), None, &mut conn), 200);
        assert_eq!(status(None, None, &mut conn), 401);
        assert_eq!(status(Some("Bearer wrong"), None, &mut conn), 401);
        assert_eq!(status(Some(&bearer), Some("https://evil.example"), &mut conn), 403);
        drop(conn);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn a_clip_becomes_a_task_with_its_page_as_provenance() {
        let (path, mut conn) = temp_db();
        let r = post(
            &mut conn,
            r#"{"url":"https://example.com/q3","title":"  Q3 budget\n thread ","excerpt":"Can you send numbers by Monday?","intent":"reply","browser":"Chrome"}"#,
        );
        assert_eq!(r.status, 201, "{:?}", r.body);
        let task = conn
            .query_row(&format!("SELECT {TASK_COLS} FROM tasks"), [], task_from_row)
            .unwrap();
        assert_eq!(task.text, "Reply to “Q3 budget thread”");
        assert_eq!(task.source, "clip:reply");
        assert_eq!(task.source_ref.as_deref(), Some("https://example.com/q3"));
        assert_eq!(task.source_excerpt.as_deref(), Some("Can you send numbers by Monday?"));
        assert_eq!(task.source_client.as_deref(), Some("Chrome"));
        assert_eq!(task.due_at, Some(tomorrow_morning(fri_1030())), "a Reply is due tomorrow morning");
        drop(conn);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn read_has_no_due_date_and_the_same_clip_twice_is_one_task() {
        let (path, mut conn) = temp_db();
        let body = r#"{"url":"https://example.com/essay","title":"An essay","intent":"read"}"#;
        let first = post(&mut conn, body);
        assert_eq!((first.status, first.body["due_at"].clone()), (201, json!(null)));
        let again = post(&mut conn, body);
        assert_eq!((again.status, again.body["duplicate"].clone()), (200, json!(true)));
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        drop(conn);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn bad_clips_are_refused() {
        let (path, mut conn) = temp_db();
        assert_eq!(post(&mut conn, r#"{"url":"javascript:alert(1)","intent":"read"}"#).status, 400);
        assert_eq!(post(&mut conn, r#"{"url":"https://a.b","intent":"hoard"}"#).status, 400);
        assert_eq!(post(&mut conn, "not json").status, 400);
        let long = format!(r#"{{"url":"https://a.b","intent":"read","excerpt":"{}"}}"#, "word ".repeat(100));
        assert_eq!(post(&mut conn, &long).status, 201);
        let excerpt: String = conn.query_row("SELECT source_excerpt FROM tasks", [], |r| r.get(0)).unwrap();
        assert!(excerpt.chars().count() <= EXCERPT_MAX && excerpt.ends_with('…'), "{excerpt}");
        let text: String = conn.query_row("SELECT text FROM tasks", [], |r| r.get(0)).unwrap();
        assert_eq!(text, "Read “a.b”", "no title: the address stands in");
        drop(conn);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn the_server_answers_over_http() {
        let (db, conn) = temp_db();
        drop(conn);
        // Find a free port, then serve on it.
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let addr = format!("127.0.0.1:{port}");
        let (serve_addr, serve_db) = (addr.clone(), db.clone());
        std::thread::spawn(move || serve(&serve_addr, serve_db, TOKEN.into()));
        let send = |raw: String| -> String {
            for _ in 0..50 {
                if let Ok(mut s) = std::net::TcpStream::connect(&addr) {
                    s.write_all(raw.as_bytes()).unwrap();
                    let mut out = String::new();
                    s.read_to_string(&mut out).unwrap();
                    return out;
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            panic!("server didn't start");
        };
        let body = r#"{"url":"https://example.com","title":"Example","intent":"decide","browser":"Edge"}"#;
        let ok = send(format!(
            "POST /clip HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {TOKEN}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        ));
        assert!(ok.starts_with("HTTP/1.1 201"), "{ok}");
        assert!(ok.contains("Decide on “Example”"), "{ok}");
        let big = "x".repeat(MAX_BODY + 10);
        let too_big = send(format!(
            "POST /clip HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {TOKEN}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{big}",
            big.len()
        ));
        assert!(too_big.starts_with("HTTP/1.1 413"), "{too_big}");
        let unpaired = send("GET /status HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n".into());
        assert!(unpaired.starts_with("HTTP/1.1 401"), "{unpaired}");
        let _ = std::fs::remove_file(db);
    }

    #[test]
    fn the_pairing_code_is_made_once_and_kept() {
        let path = std::env::temp_dir().join(format!("stickyinc-token-{}", uuid::Uuid::new_v4()));
        let first = load_or_create_token(&path).unwrap();
        assert!(first.len() >= 32);
        assert_eq!(load_or_create_token(&path).unwrap(), first);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let _ = std::fs::remove_file(path);
    }
}
