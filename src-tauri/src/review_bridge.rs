use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::git::AppState;

const SERVER_INFO_FILENAME: &str = "review-bridge.json";
const SERVER_START_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ActionType {
    ChangeRequest,
    Question,
    Nit,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewComment {
    pub key: String,
    pub file_path: String,
    pub line_start: u32,
    pub line_end: u32,
    pub comment: String,
    pub action_type: ActionType,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommentIdMapping {
    pub key: String,
    pub id: String,
}

#[derive(Debug, Serialize)]
pub struct SubmitReviewResponse {
    pub submitted_count: usize,
    pub comment_ids: Vec<CommentIdMapping>,
}

#[derive(Debug, Deserialize)]
struct ServerInfo {
    port: u16,
}

/// SSE event payload pushed from HTTP server → Tauri frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommentStatusChanged {
    pub review_id: String,
    pub comment_id: String,
    pub status: String,
    pub summary: Option<String>,
    pub dismiss_reason: Option<String>,
}

fn state_dir() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| "failed to resolve home directory".to_string())?;
    Ok(home.join(".cub"))
}

fn server_info_path() -> Result<PathBuf, String> {
    Ok(state_dir()?.join(SERVER_INFO_FILENAME))
}

#[cfg(debug_assertions)]
fn workspace_root() -> Result<PathBuf, String> {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "failed to resolve workspace root".to_string())
}

#[cfg(not(debug_assertions))]
fn workspace_root() -> Result<PathBuf, String> {
    let exe =
        std::env::current_exe().map_err(|e| format!("failed to resolve executable path: {e}"))?;
    // Canonicalise so a launcher symlink (e.g. /opt/homebrew/bin/cub created
    // by the Homebrew cask `binary` stanza) resolves to the real .app path —
    // otherwise the sidecar lookup walks the wrong tree.
    let exe = std::fs::canonicalize(&exe).unwrap_or(exe);
    exe.parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "failed to resolve workspace root from executable".to_string())
}

pub fn sidecar_script_path() -> Result<PathBuf, String> {
    let root = workspace_root()?;
    // Prefer the bundled, dependency-inlined sidecar (shipped in release
    // builds). Fall back to the raw script (works in `bun run tauri dev`
    // because the repo's node_modules is on the import-resolution path).
    let candidates = [
        // macOS .app bundle: Contents/Resources/_up_/sidecar/<file>
        root.join("../Resources/_up_/sidecar/cub-mcp.bundled.js"),
        root.join("../Resources/sidecar/cub-mcp.bundled.js"),
        root.join("sidecar").join("cub-mcp.bundled.js"),
        root.join("cub-mcp.bundled.js"),
        // Dev / unbundled fallback.
        root.join("sidecar").join("cub-mcp.js"),
        root.join("cub-mcp.js"),
    ];
    for c in &candidates {
        if c.exists() {
            return Ok(c.clone());
        }
    }
    Err(format!(
        "missing sidecar script (checked {})",
        candidates
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(", ")
    ))
}

/// Resolve a `bun` executable. The shipped sidecar is a single bun-bundled
/// script that depends on `bun:sqlite`, so a working bun runtime is required.
///
/// When `Cub.app` is launched from Finder, the inherited PATH is the minimal
/// `/usr/bin:/bin:/usr/sbin:/sbin` set — Homebrew and the bun installer write
/// to locations outside that set, so a plain `Command::new("bun")` cannot find
/// them. Walk the common install paths first, then fall back to PATH.
pub fn find_bun() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = vec![
        PathBuf::from("/opt/homebrew/bin/bun"),
        PathBuf::from("/usr/local/bin/bun"),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        candidates.push(home.join(".bun/bin/bun"));
        candidates.push(home.join(".local/bin/bun"));
    }
    for c in &candidates {
        if c.is_file() {
            return Some(c.clone());
        }
    }
    // PATH-based lookup as a last resort (covers atypical installs).
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            let p = dir.join("bun");
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

fn read_server_info() -> Result<Option<ServerInfo>, String> {
    let path = server_info_path()?;
    match std::fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw)
            .map(Some)
            .map_err(|e| format!("invalid server info at {}: {e}", path.display())),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(format!(
            "failed to read server info at {}: {err}",
            path.display()
        )),
    }
}

fn server_base_url(info: &ServerInfo) -> String {
    format!("http://127.0.0.1:{}", info.port)
}

fn http_agent() -> ureq::Agent {
    let config = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(5)))
        .build();
    ureq::Agent::new_with_config(config)
}

fn server_is_healthy(info: &ServerInfo) -> bool {
    http_agent()
        .get(&format!("{}/health", server_base_url(info)))
        .call()
        .is_ok()
}

fn spawn_server_process(script_path: &Path) -> Result<Child, String> {
    let root = workspace_root()?;
    let bun = find_bun().ok_or_else(|| {
        "bun not found. install via `brew install bun` or https://bun.sh".to_string()
    })?;
    Command::new(&bun)
        .arg(script_path)
        .arg("server")
        .current_dir(&root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|err| format!("failed to spawn review server with {}: {err}", bun.display()))
}

fn wait_for_server_ready(child: &mut Child) -> Result<ServerInfo, String> {
    let start = Instant::now();
    while start.elapsed() < SERVER_START_TIMEOUT {
        if let Some(status) = child
            .try_wait()
            .map_err(|e| format!("failed to poll review server: {e}"))?
        {
            return Err(format!(
                "review server exited before becoming ready: {status}"
            ));
        }

        if let Some(info) = read_server_info()? {
            if server_is_healthy(&info) {
                return Ok(info);
            }
        }

        thread::sleep(Duration::from_millis(50));
    }

    Err("timed out waiting for review server to start".to_string())
}

fn ensure_server_running(state: &AppState) -> Result<ServerInfo, String> {
    if let Some(info) = read_server_info()? {
        if server_is_healthy(&info) {
            return Ok(info);
        }
    }

    {
        let mut guard = state
            .bridge
            .lock()
            .map_err(|e| format!("lock poisoned: {e}"))?;
        if let Some(child) = guard.as_mut() {
            if child.try_wait().ok().flatten().is_some() {
                *guard = None;
            }
        }
    }

    let script = sidecar_script_path()?;
    let mut child = spawn_server_process(&script)?;
    let info = wait_for_server_ready(&mut child)?;

    *state
        .bridge
        .lock()
        .map_err(|e| format!("lock poisoned: {e}"))? = Some(child);

    Ok(info)
}

pub fn start_review_server(state: &AppState) -> Result<u16, String> {
    let info = ensure_server_running(state)?;
    Ok(info.port)
}

/// Spawn a background thread that connects to the HTTP server's SSE endpoint
/// and relays `comment_status_changed` events as Tauri events.
pub fn start_event_listener(
    app_handle: AppHandle,
    port: u16,
    stop: Arc<AtomicBool>,
) -> JoinHandle<()> {
    thread::spawn(move || {
        let url = format!("http://127.0.0.1:{port}/events");
        loop {
            if stop.load(Ordering::Relaxed) {
                return;
            }

            // Build a fresh agent with no global timeout — SSE is long-lived
            let agent = {
                let config = ureq::Agent::config_builder().timeout_global(None).build();
                ureq::Agent::new_with_config(config)
            };

            let response = match agent.get(&url).call() {
                Ok(resp) => resp,
                Err(_) => {
                    // Server not ready yet or connection dropped; retry after delay
                    if stop.load(Ordering::Relaxed) {
                        return;
                    }
                    thread::sleep(Duration::from_secs(2));
                    continue;
                }
            };

            let reader = response.into_body().into_reader();
            let buf = BufReader::new(reader);

            let mut event_name = String::new();
            let mut data_buf = String::new();

            for line_result in buf.lines() {
                if stop.load(Ordering::Relaxed) {
                    return;
                }

                let line = match line_result {
                    Ok(l) => l,
                    Err(_) => break, // connection dropped, reconnect
                };

                if line.starts_with("event: ") {
                    event_name = line[7..].to_string();
                } else if line.starts_with("data: ") {
                    data_buf.push_str(&line[6..]);
                } else if line.is_empty() {
                    // End of SSE message — dispatch if we have data
                    if event_name == "comment_status_changed" && !data_buf.is_empty() {
                        if let Ok(payload) = serde_json::from_str::<CommentStatusChanged>(&data_buf)
                        {
                            let _ = app_handle.emit("review:comment-updated", &payload);
                        }
                    }
                    event_name.clear();
                    data_buf.clear();
                }
                // Lines starting with ':' are SSE comments (keep-alive), ignore
            }

            // If we reach here the connection was lost; reconnect after a delay
            if stop.load(Ordering::Relaxed) {
                return;
            }
            thread::sleep(Duration::from_secs(1));
        }
    })
}

fn validate_comments(comments: &[ReviewComment]) -> Result<(), String> {
    if comments.is_empty() {
        return Err("cannot submit an empty review".to_string());
    }

    for c in comments {
        if c.file_path.trim().is_empty() {
            return Err("review comment file path cannot be empty".to_string());
        }
        if c.comment.trim().is_empty() {
            return Err("review comment text cannot be empty".to_string());
        }
        if c.line_end < c.line_start {
            return Err(format!(
                "invalid line range for {}: {}..{}",
                c.file_path, c.line_start, c.line_end
            ));
        }
    }

    Ok(())
}

#[derive(Deserialize)]
struct SubmitResponse {
    ok: bool,
    #[serde(default)]
    accepted_count: Option<usize>,
    #[serde(default)]
    comment_ids: Option<Vec<CommentIdMapping>>,
    #[serde(default)]
    error: Option<String>,
}

#[tauri::command]
pub fn submit_review(
    comments: Vec<ReviewComment>,
    state: State<AppState>,
) -> Result<SubmitReviewResponse, String> {
    validate_comments(&comments)?;

    let info = ensure_server_running(state.inner())?;
    let url = format!("{}/reviews", server_base_url(&info));

    let response: SubmitResponse = http_agent()
        .post(&url)
        .header("Content-Type", "application/json")
        .send_json(&serde_json::json!({ "comments": comments }))
        .map_err(|e| format!("failed to submit review: {e}"))?
        .body_mut()
        .read_json()
        .map_err(|e| format!("failed to read server response: {e}"))?;

    if !response.ok {
        let msg = response
            .error
            .unwrap_or_else(|| "unknown error".to_string());
        return Err(format!("review server rejected submission: {msg}"));
    }

    let submitted_count = response
        .accepted_count
        .ok_or_else(|| "server omitted accepted_count".to_string())?;

    let comment_ids = response.comment_ids.unwrap_or_default();

    Ok(SubmitReviewResponse {
        submitted_count,
        comment_ids,
    })
}
