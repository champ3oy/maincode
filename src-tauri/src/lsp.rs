use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

struct LspSession {
    stdin: ChildStdin,
    window_label: String,
    root: String,
    server_id: String,
    refcount: u32,
}

struct LspInner {
    sessions: HashMap<u32, LspSession>,
    // Keyed by (window_label, root, server_id): each WINDOW gets its own server
    // per root per language server, so two windows on the same folder never
    // share a session id (which would broadcast/misroute responses), a
    // window's teardown stops exactly its own sessions, and multiple language
    // servers can coexist on the same root.
    by_key: HashMap<(String, String, String), u32>,
}

pub struct LspState {
    inner: Mutex<LspInner>,
    next_id: AtomicU32,
    // Per-server-id install lock. Each Tauri window is its own webview → its own
    // manager singleton → an independent `lsp_ensure_server` call, so two
    // first-time opens (or an open + the Settings "Install" button) for the same
    // absent server would otherwise race: both see `bin.exists()==false` and both
    // download/extract to the same paths, interleaving writes. This map hands out
    // one `Arc<Mutex<()>>` per server id; `lsp_ensure_server` holds it across the
    // download/extract so acquisition is serialized per server. The waiting caller
    // then sees the binary already present (double-check) and returns early. Kept
    // SEPARATE from `inner` so the blocking download never holds the sessions lock.
    install_locks: Mutex<HashMap<String, std::sync::Arc<Mutex<()>>>>,
}

impl Default for LspState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(LspInner {
                sessions: HashMap::new(),
                by_key: HashMap::new(),
            }),
            next_id: AtomicU32::new(1),
            install_locks: Mutex::new(HashMap::new()),
        }
    }
}

fn resource(app: &AppHandle, rel: &str) -> Result<std::path::PathBuf, String> {
    // Packaged builds: the bundled resource path exists and is used as-is.
    let bundled = app
        .path()
        .resolve(rel, tauri::path::BaseDirectory::Resource)
        .map_err(|e| e.to_string())?;
    if bundled.exists() {
        return Ok(bundled);
    }
    // `tauri dev` does not copy bundle resources into the dev resource dir, so
    // fall back to the source tree (compile-time manifest dir → ../resources/…).
    let dev = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../resources")
        .join(rel);
    if dev.exists() {
        return Ok(dev);
    }
    // Neither exists — return the bundled path so the spawn error names it.
    Ok(bundled)
}

/// Resolve a serverId to its (command, args). Only known servers are spawnable,
/// so the frontend can never request an arbitrary executable. Cached-binary
/// servers are added in later tasks; here only the bundled node-based ones.
fn resolve_command(app: &AppHandle, server_id: &str) -> Result<(std::path::PathBuf, Vec<String>), String> {
    let node = resource(app, "lsp/node")?;
    match server_id {
        "typescript" => {
            let cli = resource(app, "lsp/server/node_modules/typescript-language-server/lib/cli.mjs")?;
            Ok((node, vec![cli.to_string_lossy().into(), "--stdio".into()]))
        }
        "python" => {
            let cli = resource(app, "lsp/server/node_modules/pyright/langserver.index.js")?;
            Ok((node, vec![cli.to_string_lossy().into(), "--stdio".into()]))
        }
        "rust" => {
            // Prefer the toolchain-matched rust-analyzer (rustup component): it
            // always matches the user's cargo, so `cargo metadata` succeeds and
            // the workspace loads. A stale standalone binary breaks against a
            // newer cargo. Fall back to the downloaded binary for non-rustup setups.
            if let Some(p) = rustup_which("rust-analyzer") {
                return Ok((p, vec![]));
            }
            let bin = cache_dir()?.join("rust").join("rust-analyzer");
            Ok((bin, vec![]))
        }
        "cpp" => {
            let bin = cache_dir()?.join("cpp").join("clangd_18.1.3").join("bin").join("clangd");
            Ok((bin, vec![]))
        }
        "go" => {
            let bin = cache_dir()?.join("go").join("gopls");
            Ok((bin, vec![]))
        }
        "bash" => {
            let cli = resource(app, "lsp/server/node_modules/bash-language-server/out/cli.js")?;
            Ok((node, vec![cli.to_string_lossy().into(), "start".into()]))
        }
        "yaml" => {
            let cli = resource(app, "lsp/server/node_modules/yaml-language-server/bin/yaml-language-server")?;
            Ok((node, vec![cli.to_string_lossy().into(), "--stdio".into()]))
        }
        "json" => {
            let cli = resource(app, "lsp/server/node_modules/vscode-langservers-extracted/bin/vscode-json-language-server")?;
            Ok((node, vec![cli.to_string_lossy().into(), "--stdio".into()]))
        }
        "html" => {
            let cli = resource(app, "lsp/server/node_modules/vscode-langservers-extracted/bin/vscode-html-language-server")?;
            Ok((node, vec![cli.to_string_lossy().into(), "--stdio".into()]))
        }
        "css" => {
            let cli = resource(app, "lsp/server/node_modules/vscode-langservers-extracted/bin/vscode-css-language-server")?;
            Ok((node, vec![cli.to_string_lossy().into(), "--stdio".into()]))
        }
        "dockerfile" => {
            let cli = resource(app, "lsp/server/node_modules/dockerfile-language-server-nodejs/bin/docker-langserver")?;
            Ok((node, vec![cli.to_string_lossy().into(), "--stdio".into()]))
        }
        "svelte" => {
            let cli = resource(app, "lsp/server/node_modules/svelte-language-server/bin/server.js")?;
            Ok((node, vec![cli.to_string_lossy().into(), "--stdio".into()]))
        }
        "graphql" => {
            let cli = resource(app, "lsp/server/node_modules/graphql-language-service-cli/bin/graphql.js")?;
            Ok((node, vec![cli.to_string_lossy().into(), "server".into(), "-m".into(), "stream".into()]))
        }
        "vue" => {
            let cli = resource(app, "lsp/server/node_modules/@vue/language-server/bin/vue-language-server.js")?;
            Ok((node, vec![cli.to_string_lossy().into(), "--stdio".into()]))
        }
        _ => Err(format!("unknown language server: {server_id}")),
    }
}

/// A PATH that includes the user's login-shell PATH, so spawned language servers
/// can find toolchains (go/python/cargo/rustup) even when the app was launched
/// from Finder with a minimal PATH. Mirrors pty.rs's login-shell rationale.
///
/// Cached for the process: computing it spawns `$SHELL -lic` which sources the
/// full shell profile (often 200-500ms). A single Rust open resolves it several
/// times (ensure + rustup lookups + child env), so caching removes repeated
/// heavy shell spawns — some of which ran on the UI thread during spawn.
static LOGIN_PATH: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
fn login_path() -> Option<String> {
    LOGIN_PATH
        .get_or_init(|| {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
            let out = std::process::Command::new(shell)
                .args(["-lic", "printf %s \"$PATH\""])
                .output()
                .ok()?;
            let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if p.is_empty() { None } else { Some(p) }
        })
        .clone()
}

fn cache_dir() -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    Ok(std::path::PathBuf::from(home).join(".config").join("maincode").join("servers"))
}

/// Path to a rustup-managed binary for the active toolchain, if rustup and the
/// component are both present. Uses the login-shell PATH so rustup is found even
/// when the app was launched from Finder. Returns None if rustup or the
/// component is absent (caller then falls back to a downloaded binary).
fn rustup_which(bin: &str) -> Option<std::path::PathBuf> {
    let mut cmd = std::process::Command::new("rustup");
    cmd.args(["which", bin]);
    if let Some(path) = login_path() {
        cmd.env("PATH", path);
    }
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let p = std::path::PathBuf::from(String::from_utf8_lossy(&out.stdout).trim());
    if p.exists() { Some(p) } else { None }
}

/// Install a rustup component for the active toolchain (idempotent). Returns
/// true on success. Used to obtain a rust-analyzer that always matches the
/// user's cargo, avoiding version-skew where a stale standalone binary passes
/// `cargo metadata` flags a newer cargo rejects (→ "failed to load workspace").
fn rustup_add(component: &str) -> bool {
    let mut cmd = std::process::Command::new("rustup");
    cmd.args(["component", "add", component]);
    if let Some(path) = login_path() {
        cmd.env("PATH", path);
    }
    cmd.status().map(|s| s.success()).unwrap_or(false)
}

/// Download-and-cache a single-binary server distributed as a gzipped release
/// asset on GitHub. Returns early if the binary is already cached. Emits
/// `lsp-install-<server_id>` progress events for download/extract/done.
fn ensure_github_gz(app: &AppHandle, server_id: &str, bin_name: &str, url: &str) -> Result<(), String> {
    let dir = cache_dir()?.join(server_id);
    let bin = dir.join(bin_name);
    if bin.exists() {
        return Ok(());
    }
    let _ = app.emit(&format!("lsp-install-{server_id}"), serde_json::json!({ "phase": "download" }));
    let tmp = dir.join("download.gz");
    crate::server_acquire::download(url, &tmp)?;
    let _ = app.emit(&format!("lsp-install-{server_id}"), serde_json::json!({ "phase": "extract" }));
    crate::server_acquire::extract_gz(&tmp, &bin)?;
    let _ = std::fs::remove_file(&tmp);
    let _ = app.emit(&format!("lsp-install-{server_id}"), serde_json::json!({ "phase": "done" }));
    Ok(())
}

/// Per-server acquisition. Bundled servers are no-ops; download/go-install
/// servers fetch+extract into the cache. Emits `lsp-install-<id>` progress
/// events. Serialized per server id via `state.install_locks` so concurrent
/// first-time opens from separate windows never interleave writes to the same
/// files; the per-arm `if bin.exists() { return Ok(()) }` acts as the
/// double-check once a waiter acquires the lock.
/// Ensure a language server's binary is present, downloading/installing on
/// first use. `async` + `spawn_blocking` so the blocking download/extract (and
/// `go install`, which compiles gopls and takes tens of seconds) NEVER runs on
/// the main thread — a synchronous Tauri command runs on the UI thread and would
/// freeze the whole app (including the "Installing…" indicator, which then can't
/// even paint). Serialized per server id via `state.install_locks`; the per-arm
/// `bin.exists()` is the double-check once a waiter acquires the lock.
#[tauri::command]
pub async fn lsp_ensure_server(
    server_id: String,
    app: AppHandle,
    state: State<'_, LspState>,
) -> Result<(), String> {
    // Clone the per-id lock Arc on the calling side (cheap), then move it into
    // the blocking task and hold it there for the whole download. Kept SEPARATE
    // from `state.inner` so the download never holds the sessions mutex.
    let lock = {
        let mut m = state.install_locks.lock().map_err(|_| "lock poisoned")?;
        m.entry(server_id.clone()).or_default().clone()
    };
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.lock().map_err(|_| "install lock poisoned")?;
        ensure_server_blocking(&server_id, &app)
    })
    .await
    .map_err(|e| format!("install task panicked: {e}"))?
}

/// The blocking half of `lsp_ensure_server`, run on a blocking thread. Bundled
/// (node-based) arms are no-ops; download/go-install arms fetch + extract into
/// the cache and emit `lsp-install-<id>` progress events.
fn ensure_server_blocking(server_id: &str, app: &AppHandle) -> Result<(), String> {
    match server_id {
        // Bundled (node-based): nothing to acquire.
        "typescript" | "python" | "bash" | "yaml" | "json" | "html" | "css" | "dockerfile" | "svelte" | "graphql" | "vue" => Ok(()),
        "rust" => {
            // Prefer the rustup toolchain rust-analyzer (version-matched to the
            // user's cargo). Fall back to a current standalone release only when
            // rustup is unavailable. Pin kept recent so the fallback also works
            // against a modern cargo's `cargo metadata`.
            if rustup_which("rust-analyzer").is_some() || rustup_add("rust-analyzer") {
                return Ok(());
            }
            ensure_github_gz(
                app,
                "rust",
                "rust-analyzer",
                &format!(
                    "https://github.com/rust-lang/rust-analyzer/releases/download/2026-07-13/rust-analyzer-{}-apple-darwin.gz",
                    std::env::consts::ARCH // "aarch64" | "x86_64"
                ),
            )
        }
        "cpp" => {
            let dir = cache_dir()?.join("cpp");
            // resolve_command("cpp") returns exactly this path; it must exist
            // only after a fully successful extract + atomic rename below.
            let bin = dir.join("clangd_18.1.3").join("bin").join("clangd");
            if bin.exists() {
                return Ok(());
            }
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            // Clear any stale `.partial` left by a prior crash (installs are
            // serialized per id, so no live writer can own it).
            let staging = dir.join(".partial");
            let _ = std::fs::remove_dir_all(&staging);
            let _ = app.emit("lsp-install-cpp", serde_json::json!({ "phase": "download" }));
            let zip = dir.join("clangd.zip");
            let acquire = (|| -> Result<(), String> {
                crate::server_acquire::download(
                    "https://github.com/clangd/clangd/releases/download/18.1.3/clangd-mac-18.1.3.zip",
                    &zip,
                )?;
                let _ = app.emit("lsp-install-cpp", serde_json::json!({ "phase": "extract" }));
                // Extract the nested tree into the staging dir, then atomically
                // rename the extracted `clangd_18.1.3` root onto its final path.
                // `dest_dir/clangd_18.1.3/bin/clangd` never exists partially.
                crate::server_acquire::extract_zip(&zip, &staging)?;
                let extracted = staging.join("clangd_18.1.3");
                let final_root = dir.join("clangd_18.1.3");
                let _ = std::fs::remove_dir_all(&final_root);
                std::fs::rename(&extracted, &final_root).map_err(|e| e.to_string())?;
                Ok(())
            })();
            let _ = std::fs::remove_file(&zip);
            let _ = std::fs::remove_dir_all(&staging);
            acquire?;
            let _ = app.emit("lsp-install-cpp", serde_json::json!({ "phase": "done" }));
            Ok(())
        }
        "go" => {
            let dir = cache_dir()?.join("go");
            let bin = dir.join("gopls");
            if bin.exists() {
                return Ok(());
            }
            let _ = app.emit("lsp-install-go", serde_json::json!({ "phase": "install" }));
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let mut cmd = std::process::Command::new("go");
            cmd.args(["install", "golang.org/x/tools/gopls@v0.16.2"]).env("GOBIN", &dir);
            if let Some(path) = login_path() {
                cmd.env("PATH", path);
            }
            let status = cmd.status().map_err(|_| "Go toolchain not found — install Go to use gopls".to_string())?;
            if !status.success() {
                return Err("go install gopls failed".into());
            }
            let _ = app.emit("lsp-install-go", serde_json::json!({ "phase": "done" }));
            Ok(())
        }
        _ => Err(format!("no acquire strategy for {server_id}")),
    }
}

#[derive(serde::Serialize)]
pub struct ServerStatus {
    server_id: String,
    label: String,
    languages: Vec<String>,
    kind: String,  // "bundled" | "github-release" | "go-install"
    state: String, // "builtin" | "installed" | "missing"
}

#[tauri::command]
pub fn lsp_server_status(app: AppHandle) -> Vec<ServerStatus> {
    let entry = |id: &str, label: &str, langs: &[&str], kind: &str| {
        let state = match kind {
            "bundled" => "builtin".to_string(),
            _ => {
                let present = resolve_command(&app, id).map(|(c, _)| c.exists()).unwrap_or(false);
                (if present { "installed" } else { "missing" }).to_string()
            }
        };
        ServerStatus { server_id: id.into(), label: label.into(), languages: langs.iter().map(|s| s.to_string()).collect(), kind: kind.into(), state }
    };
    vec![
        entry("typescript", "TypeScript / JavaScript", &["ts", "tsx", "js", "jsx"], "bundled"),
        entry("python", "Python (Pyright)", &["py"], "bundled"),
        entry("bash", "Bash", &["sh", "bash"], "bundled"),
        entry("yaml", "YAML", &["yml", "yaml"], "bundled"),
        entry("json", "JSON", &["json"], "bundled"),
        entry("html", "HTML", &["html"], "bundled"),
        entry("css", "CSS", &["css"], "bundled"),
        entry("dockerfile", "Dockerfile", &["dockerfile"], "bundled"),
        entry("svelte", "Svelte", &["svelte"], "bundled"),
        entry("graphql", "GraphQL", &["graphql", "gql"], "bundled"),
        entry("vue", "Vue", &["vue"], "bundled"),
        entry("rust", "Rust (rust-analyzer)", &["rs"], "github-release"),
        entry("cpp", "C / C++ (clangd)", &["c", "cpp"], "github-release"),
        entry("go", "Go (gopls)", &["go"], "go-install"),
    ]
}

/// Per-server `initializationOptions` with resolved resource paths. Returns
/// `null` for servers needing none. Vue (Volar) requires the bundled TypeScript
/// SDK lib dir.
#[tauri::command]
pub fn lsp_init_options(server_id: String, app: AppHandle) -> Result<Option<serde_json::Value>, String> {
    match server_id.as_str() {
        "vue" => {
            let tsdk = resource(&app, "lsp/server/node_modules/typescript/lib")?;
            Ok(Some(serde_json::json!({ "typescript": { "tsdk": tsdk.to_string_lossy() } })))
        }
        _ => Ok(None),
    }
}

#[tauri::command]
pub fn lsp_remove_server(server_id: String) -> Result<(), String> {
    // Only the known, Rust-authoritative server ids may be removed. This blocks
    // absolute/`..` server_id values from escaping the cache dir (join() would
    // otherwise resolve them to arbitrary paths).
    if !matches!(server_id.as_str(), "typescript" | "python" | "rust" | "cpp" | "go") {
        return Err(format!("unknown server id: {server_id}"));
    }
    let cache = cache_dir()?;
    let dir = cache.join(&server_id);
    // Defense in depth: the resolved dir must stay inside the cache root.
    if !dir.starts_with(&cache) {
        return Err("refusing to remove path outside cache".into());
    }
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn lsp_spawn(
    server_id: String,
    root: String,
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<LspState>,
) -> Result<u32, String> {
    let label = window.label().to_string();
    let key = (label.clone(), root.clone(), server_id.clone());
    // Single lock over both maps, held across spawn so check-reuse-or-insert is
    // atomic: no lock-order inversion (one lock) and no TOCTOU duplicate server
    // for the same (window, root, server_id). Spawn is rare (once per project
    // open), so briefly holding the lock across it is acceptable.
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    if let Some(&id) = inner.by_key.get(&key) {
        if let Some(s) = inner.sessions.get_mut(&id) {
            s.refcount += 1;
            return Ok(id);
        }
    }

    let (command, args) = resolve_command(&app, &server_id)?;
    let mut cmd = Command::new(command);
    cmd.args(&args)
        .current_dir(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(path) = login_path() {
        cmd.env("PATH", path);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn {server_id}: {e}"))?;

    let stdin = child.stdin.take().ok_or("no stdin")?;
    let id = state.next_id.fetch_add(1, Ordering::SeqCst);

    // The reader thread OWNS the child: it drains stdout to EOF (process exit),
    // then wait()s to reap it (no zombies), then emits exit. Both explicit stop
    // (lsp_stop drops the session's stdin → server exits on stdin EOF) and a
    // self-exit/crash flow through this same EOF path. Events are emitted to the
    // OWNING window only (emit_to), so a same-root server in another window can't
    // receive them.
    let app_out = app.clone();
    let emit_label = label.clone();
    std::thread::spawn(move || {
        if let Some(mut stdout) = child.stdout.take() {
            let mut carry: Vec<u8> = Vec::new();
            let mut buf = [0u8; 8192];
            loop {
                match stdout.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        carry.extend_from_slice(&buf[..n]);
                        for msg in parse_frames(&mut carry) {
                            let _ = app_out.emit_to(emit_label.as_str(), &format!("lsp-msg-{id}"), msg);
                        }
                    }
                }
            }
        }
        let _ = child.wait();
        let _ = app_out.emit_to(emit_label.as_str(), &format!("lsp-exit-{id}"), ());
    });

    inner.sessions.insert(
        id,
        LspSession {
            stdin,
            window_label: label,
            root,
            server_id,
            refcount: 1,
        },
    );
    inner.by_key.insert(key, id);
    Ok(id)
}

#[tauri::command]
pub fn lsp_send(id: u32, message: String, state: State<LspState>) -> Result<(), String> {
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    let s = inner.sessions.get_mut(&id).ok_or("no such LSP session")?;
    let framed = format!("Content-Length: {}\r\n\r\n{}", message.len(), message);
    s.stdin.write_all(framed.as_bytes()).map_err(|e| e.to_string())?;
    s.stdin.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn lsp_stop(id: u32, state: State<LspState>) -> Result<(), String> {
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    let should_remove = match inner.sessions.get_mut(&id) {
        Some(s) => {
            s.refcount = s.refcount.saturating_sub(1);
            s.refcount == 0
        }
        None => return Ok(()),
    };
    if should_remove {
        if let Some(removed) = inner.sessions.remove(&id) {
            inner
                .by_key
                .remove(&(removed.window_label, removed.root, removed.server_id));
            drop(removed.stdin); // close stdin → server exits → reader thread reaps
        }
    }
    Ok(())
}

/// Stop and reap every LSP session owned by `label`'s window. Called from the
/// window-Destroyed handler because the JS-side dispose()/lsp_stop may not run
/// before the webview is torn down, which would otherwise leak the server +
/// reader thread until app exit. Dropping each session's stdin makes the server
/// exit on stdin EOF; its reader thread then wait()s and reaps it.
pub fn stop_window(label: &str, state: State<LspState>) {
    let Ok(mut inner) = state.inner.lock() else {
        return;
    };
    let ids: Vec<u32> = inner
        .sessions
        .iter()
        .filter(|(_, s)| s.window_label == label)
        .map(|(&id, _)| id)
        .collect();
    for id in ids {
        if let Some(removed) = inner.sessions.remove(&id) {
            inner
                .by_key
                .remove(&(removed.window_label, removed.root, removed.server_id));
            drop(removed.stdin);
        }
    }
}

/// Drain every complete LSP message (`Content-Length: N\r\n\r\n<N bytes>`) from
/// `buf`, returning the JSON bodies. A partial trailing frame stays in `buf` for
/// the next read. Framing is done in bytes so multibyte UTF-8 split across reads
/// is handled correctly.
pub fn parse_frames(buf: &mut Vec<u8>) -> Vec<String> {
    let mut out = Vec::new();
    loop {
        // Find header/body separator.
        let Some(sep) = find_subslice(buf, b"\r\n\r\n") else { break };
        let header = &buf[..sep];
        let Some(len) = content_length(header) else {
            // Malformed header: drop up to and including the separator, continue.
            buf.drain(..sep + 4);
            continue;
        };
        let body_start = sep + 4;
        if buf.len() < body_start + len {
            break; // body not fully arrived yet
        }
        let body = buf[body_start..body_start + len].to_vec();
        buf.drain(..body_start + len);
        if let Ok(s) = String::from_utf8(body) {
            out.push(s);
        }
    }
    out
}

fn find_subslice(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

fn content_length(header: &[u8]) -> Option<usize> {
    let text = std::str::from_utf8(header).ok()?;
    for line in text.split("\r\n") {
        if let Some(rest) = line
            .to_ascii_lowercase()
            .strip_prefix("content-length:")
        {
            return rest.trim().parse::<usize>().ok();
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(body: &str) -> Vec<u8> {
        format!("Content-Length: {}\r\n\r\n{}", body.len(), body).into_bytes()
    }

    #[test]
    fn parses_single_frame() {
        let mut buf = frame("{\"a\":1}");
        assert_eq!(parse_frames(&mut buf), vec!["{\"a\":1}".to_string()]);
        assert!(buf.is_empty());
    }

    #[test]
    fn parses_multiple_frames_in_one_read() {
        let mut buf = frame("{\"a\":1}");
        buf.extend(frame("{\"b\":2}"));
        assert_eq!(
            parse_frames(&mut buf),
            vec!["{\"a\":1}".to_string(), "{\"b\":2}".to_string()]
        );
    }

    #[test]
    fn keeps_partial_frame_until_body_arrives() {
        let full = frame("{\"hi\":true}");
        let mut buf = full[..full.len() - 3].to_vec(); // missing last 3 bytes
        assert_eq!(parse_frames(&mut buf), Vec::<String>::new());
        buf.extend_from_slice(&full[full.len() - 3..]);
        assert_eq!(parse_frames(&mut buf), vec!["{\"hi\":true}".to_string()]);
    }

    #[test]
    fn handles_multibyte_body_split_across_reads() {
        let body = "{\"s\":\"café→\"}"; // multibyte UTF-8
        let full = frame(body);
        let cut = full.len() - 2; // split inside a multibyte sequence
        let mut buf = full[..cut].to_vec();
        assert!(parse_frames(&mut buf).is_empty());
        buf.extend_from_slice(&full[cut..]);
        assert_eq!(parse_frames(&mut buf), vec![body.to_string()]);
    }
}
