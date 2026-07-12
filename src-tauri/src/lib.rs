mod git;
mod menu;
mod watcher;
mod fs_ops;
mod pty;

use git::AppState;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::{Mutex, OnceLock};
use tauri::{Emitter, Manager};

static LAUNCH_PATH: OnceLock<PathBuf> = OnceLock::new();

/// Record an initial folder path supplied on the command line. Called before
/// Tauri is built so the frontend can pick it up on mount.
pub fn set_launch_path(path: PathBuf) {
    let _ = LAUNCH_PATH.set(path);
}

#[tauri::command]
fn get_launch_path() -> Option<String> {
    LAUNCH_PATH.get().map(|p| p.to_string_lossy().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .menu(|handle| menu::build_menu(handle))
        .on_menu_event(|app, event| {
            // Forward custom menu-item ids to the frontend; predefined items
            // (copy/paste/quit/…) are handled natively.
            let _ = app.emit("menu-action", event.id().0.as_str());
        })
        .manage(AppState {
            repo: Mutex::new(None),
            watcher: Mutex::new(None),
            watcher_generation: AtomicU64::new(0),
        })
        .manage(pty::PtyState::default())
        .invoke_handler(tauri::generate_handler![
            git::open_repo,
            git::get_repo_status,
            git::get_file_contents_batch,
            git::stage_file,
            git::unstage_file,
            git::stage_all,
            git::unstage_all,
            git::commit,
            git::get_repo_branch,
            git::discard_file,
            git::list_branches,
            git::checkout_branch,
            get_launch_path,
            fs_ops::read_dir,
            fs_ops::read_file,
            fs_ops::write_file,
            fs_ops::create_file,
            fs_ops::create_dir,
            fs_ops::rename_path,
            fs_ops::delete_path,
            fs_ops::list_files_recursive,
            fs_ops::search_file_contents,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(move |app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            let state: &AppState = app_handle.state::<AppState>().inner();
            // Drop the file watcher so the notify background thread exits.
            if let Ok(mut guard) = state.watcher.lock() {
                *guard = None;
            }
        }
    });
}
