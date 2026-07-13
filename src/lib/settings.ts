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

/** Pseudo-path used to identify the settings pseudo-tab. */
export const SETTINGS_PATH = "maincode://settings";

/** Returns true when the given path is the settings pseudo-tab. */
export function isSettingsPath(path: string): boolean {
  return path === SETTINGS_PATH;
}
