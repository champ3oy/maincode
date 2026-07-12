// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // First non-flag positional argument = launch path.
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Some(path) = args.iter().find(|a| !a.starts_with('-')) {
        if let Ok(abs) = std::fs::canonicalize(path) {
            cub_lib::set_launch_path(abs);
        } else {
            eprintln!("[cub] could not resolve path: {path}");
        }
    }
    cub_lib::run();
}
