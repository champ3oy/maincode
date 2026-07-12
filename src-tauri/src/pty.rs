use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

pub struct PtySession {
    master: Box<dyn portable_pty::MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn portable_pty::ChildKiller + Send + Sync>,
}

pub struct PtyState {
    pub sessions: Mutex<HashMap<u32, PtySession>>,
    pub next_id: AtomicU32,
}

impl Default for PtyState {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            next_id: AtomicU32::new(1),
        }
    }
}

/// Decode as much of `carry` as is valid UTF-8, keeping an incomplete
/// trailing sequence (≤4 bytes) for the next chunk.
fn drain_utf8(carry: &mut Vec<u8>) -> String {
    match std::str::from_utf8(carry) {
        Ok(s) => {
            let out = s.to_string();
            carry.clear();
            out
        }
        Err(e) => {
            let valid = e.valid_up_to();
            let out = String::from_utf8_lossy(&carry[..valid]).to_string();
            carry.drain(..valid);
            if carry.len() > 4 {
                // Not a split sequence — genuinely invalid bytes; flush lossily.
                let rest = String::from_utf8_lossy(carry).to_string();
                carry.clear();
                return out + &rest;
            }
            out
        }
    }
}

#[tauri::command]
pub fn pty_spawn(
    cwd: String,
    cols: u16,
    rows: u16,
    app: AppHandle,
    state: State<PtyState>,
) -> Result<u32, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut cmd = CommandBuilder::new(&shell);
    cmd.cwd(&cwd);
    cmd.env("TERM", "xterm-256color");
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let killer = child.clone_killer();
    let id = state.next_id.fetch_add(1, Ordering::SeqCst);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let app_out = app.clone();
    std::thread::spawn(move || {
        let mut carry: Vec<u8> = Vec::new();
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    carry.extend_from_slice(&buf[..n]);
                    let text = drain_utf8(&mut carry);
                    if !text.is_empty() {
                        let _ = app_out.emit(&format!("pty-output-{id}"), text);
                    }
                }
            }
        }
        let _ = app_out.emit(&format!("pty-exit-{id}"), ());
    });

    // Reap the child so it doesn't zombie.
    std::thread::spawn(move || {
        let _ = child.wait();
    });

    state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .insert(
            id,
            PtySession {
                master: pair.master,
                writer,
                killer,
            },
        );
    Ok(id)
}

#[tauri::command]
pub fn pty_write(id: u32, data: String, state: State<PtyState>) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions.get_mut(&id).ok_or("no such pty session")?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(
    id: u32,
    cols: u16,
    rows: u16,
    state: State<PtyState>,
) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions.get(&id).ok_or("no such pty session")?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(id: u32, state: State<PtyState>) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    if let Some(mut session) = sessions.remove(&id) {
        let _ = session.killer.kill();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pty_pair_runs_a_command_and_produces_output() {
        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut cmd = CommandBuilder::new("/bin/echo");
        cmd.arg("hello-pty");
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut out = String::new();
        let _ = reader.read_to_string(&mut out);
        child.wait().unwrap();
        assert!(out.contains("hello-pty"), "got: {out:?}");
    }
}
