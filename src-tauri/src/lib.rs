mod git;
mod menu;
mod watcher;
mod fs_ops;
mod pty;
mod lsp;
mod server_acquire;
mod settings;
#[cfg(target_os = "macos")]
mod dock_menu;

use git::AppState;
use std::path::PathBuf;
use std::sync::OnceLock;
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

/// The label of the currently focused window, falling back to `main`.
fn focused_window_label(app: &tauri::AppHandle) -> String {
    app.webview_windows()
        .into_iter()
        .find(|(_, w)| w.is_focused().unwrap_or(false))
        .map(|(label, _)| label)
        .unwrap_or_else(|| "main".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .menu(|handle| menu::build_menu(handle))
        .setup(|_app| {
            // Install the macOS Dock-menu "New Window" item. Runs on the main
            // thread after the NSApplication delegate exists (both required).
            #[cfg(target_os = "macos")]
            dock_menu::install(_app.handle());
            Ok(())
        })
        .on_menu_event(|app, event| {
            let id = event.id().0.as_str();
            if id == "new-window" {
                if let Err(e) = menu::open_new_window(app) {
                    eprintln!("[maincode] failed to open new window: {e}");
                }
                return;
            }
            // Forward every other custom action to the focused window only, so
            // Save / New File / Toggle Terminal act on the active window.
            let label = focused_window_label(app);
            let _ = app.emit_to(label.as_str(), "menu-action", id);
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let label = window.label().to_string();
                window.state::<AppState>().remove_window(&label);
                // Stop any LSP servers this window owned — the JS dispose() may
                // not run before the webview is torn down, which would leak them.
                lsp::stop_window(&label, window.state::<lsp::LspState>());
            }
        })
        .manage(AppState::default())
        .manage(pty::PtyState::default())
        .manage(lsp::LspState::default())
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
            fs_ops::read_image_base64,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            lsp::lsp_spawn,
            lsp::lsp_send,
            lsp::lsp_stop,
            lsp::lsp_ensure_server,
            settings::read_settings,
            settings::write_settings,
            settings::settings_path,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(move |app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            let state: tauri::State<AppState> = app_handle.state::<AppState>();
            if let Ok(mut map) = state.windows.lock() {
                map.clear();
            };
        }
    });
}
