import { invoke } from "@tauri-apps/api/core";

export function readSettings(): Promise<string> {
  return invoke<string>("read_settings");
}

export function writeSettings(json: string): Promise<void> {
  return invoke<void>("write_settings", { json });
}

export function settingsPath(): Promise<string> {
  return invoke<string>("settings_path");
}
