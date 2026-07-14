use std::collections::HashMap;
use std::io::Write;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

struct LspSession {
    child: Child,
    stdin: ChildStdin,
    root: String,
    refcount: u32,
}

pub struct LspState {
    sessions: Mutex<HashMap<u32, LspSession>>,
    by_root: Mutex<HashMap<String, u32>>,
    next_id: AtomicU32,
}

impl Default for LspState {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            by_root: Mutex::new(HashMap::new()),
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
pub fn lsp_spawn(root: String, app: AppHandle, state: State<LspState>) -> Result<u32, String> {
    // Reuse an existing server for this root (refcount++).
    {
        let by_root = state.by_root.lock().map_err(|e| e.to_string())?;
        if let Some(&id) = by_root.get(&root) {
            let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
            if let Some(s) = sessions.get_mut(&id) {
                s.refcount += 1;
                return Ok(id);
            }
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
    let mut stdout = child.stdout.take().ok_or("no stdout")?;
    let id = state.next_id.fetch_add(1, Ordering::SeqCst);

    // Reader thread: accumulate bytes, drain complete frames, emit each.
    let app_out = app.clone();
    std::thread::spawn(move || {
        use std::io::Read;
        let mut carry: Vec<u8> = Vec::new();
        let mut buf = [0u8; 8192];
        loop {
            match stdout.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    carry.extend_from_slice(&buf[..n]);
                    for msg in parse_frames(&mut carry) {
                        let _ = app_out.emit(&format!("lsp-msg-{id}"), msg);
                    }
                }
            }
        }
        let _ = app_out.emit(&format!("lsp-exit-{id}"), ());
    });

    state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id, LspSession { child, stdin, root: root.clone(), refcount: 1 });
    state
        .by_root
        .lock()
        .map_err(|e| e.to_string())?
        .insert(root, id);
    Ok(id)
}

#[tauri::command]
pub fn lsp_send(id: u32, message: String, state: State<LspState>) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let s = sessions.get_mut(&id).ok_or("no such LSP session")?;
    let framed = format!("Content-Length: {}\r\n\r\n{}", message.len(), message);
    s.stdin.write_all(framed.as_bytes()).map_err(|e| e.to_string())?;
    s.stdin.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn lsp_stop(id: u32, state: State<LspState>) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let should_remove = {
        let Some(s) = sessions.get_mut(&id) else { return Ok(()) };
        s.refcount = s.refcount.saturating_sub(1);
        s.refcount == 0
    };
    if should_remove {
        if let Some(mut removed) = sessions.remove(&id) {
            let _ = removed.child.kill();
            state.by_root.lock().map_err(|e| e.to_string())?.remove(&removed.root);
        }
    }
    Ok(())
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
