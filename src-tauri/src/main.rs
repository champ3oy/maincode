// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::{Command, ExitCode};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();

    if args.iter().any(|a| a == "--mcp" || a == "-m") {
        return run_mcp_mode();
    }

    // First non-flag positional = launch path
    if let Some(path) = args.iter().find(|a| !a.starts_with('-')) {
        if let Ok(abs) = std::fs::canonicalize(path) {
            cub_lib::set_launch_path(abs);
        } else {
            eprintln!("[cub] could not resolve path: {path}");
        }
    }

    cub_lib::run();
    ExitCode::SUCCESS
}

fn run_mcp_mode() -> ExitCode {
    let script = match cub_lib::sidecar_script_path() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[cub] {e}");
            return ExitCode::from(2);
        }
    };

    let bun = match cub_lib::find_bun() {
        Some(p) => p,
        None => {
            eprintln!(
                "[cub] bun not found. install via `brew install bun` or https://bun.sh"
            );
            return ExitCode::from(1);
        }
    };

    let status = match Command::new(&bun).arg(&script).arg("mcp").status() {
        Ok(s) => s,
        Err(err) => {
            eprintln!(
                "[cub] failed to spawn MCP sidecar with {}: {err}",
                bun.display()
            );
            return ExitCode::from(1);
        }
    };

    ExitCode::from(status.code().unwrap_or(1).clamp(0, 255) as u8)
}
