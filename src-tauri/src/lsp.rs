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
    refcount: u32,
}

struct LspInner {
    sessions: HashMap<u32, LspSession>,
    // Keyed by (window_label, root): each WINDOW gets its own server per root, so
    // two windows on the same folder never share a session id (which would
    // broadcast/misroute responses), and a window's teardown stops exactly its
    // own sessions.
    by_key: HashMap<(String, String), u32>,
}

pub struct LspState {
    inner: Mutex<LspInner>,
    next_id: AtomicU32,
}

impl Default for LspState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(LspInner {
                sessions: HashMap::new(),
                by_key: HashMap::new(),
            }),
            next_id: AtomicU32::new(1),
        }
    }
}

fn resource(app: &AppHandle, rel: &str) -> Result<std::path::PathBuf, String> {
    app.path()
        .resolve(rel, tauri::path::BaseDirectory::Resource)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn lsp_spawn(
    root: String,
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<LspState>,
) -> Result<u32, String> {
    let label = window.label().to_string();
    let key = (label.clone(), root.clone());
    // Single lock over both maps, held across spawn so check-reuse-or-insert is
    // atomic: no lock-order inversion (one lock) and no TOCTOU duplicate server
    // for the same (window, root). Spawn is rare (once per project open), so
    // briefly holding the lock across it is acceptable.
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    if let Some(&id) = inner.by_key.get(&key) {
        if let Some(s) = inner.sessions.get_mut(&id) {
            s.refcount += 1;
            return Ok(id);
        }
    }

    let node = resource(&app, "lsp/node")?;
    let cli = resource(
        &app,
        "lsp/server/node_modules/typescript-language-server/lib/cli.mjs",
    )?;

    let mut child = Command::new(node)
        .arg(cli)
        .arg("--stdio")
        .current_dir(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("failed to spawn LSP server: {e}"))?;

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
            inner.by_key.remove(&(removed.window_label, removed.root));
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
            inner.by_key.remove(&(removed.window_label, removed.root));
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
