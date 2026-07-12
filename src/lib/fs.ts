import { invoke } from "@tauri-apps/api/core";

export interface DirEntryInfo {
  name: string;
  path: string;
  is_dir: boolean;
}

export interface ReadFileResult {
  content: string | null;
  reason: "binary" | "too_large" | null;
}

export function readDir(path: string): Promise<DirEntryInfo[]> {
  return invoke<DirEntryInfo[]>("read_dir", { path });
}

export function readFile(path: string): Promise<ReadFileResult> {
  return invoke<ReadFileResult>("read_file", { path });
}

export function writeFile(path: string, contents: string): Promise<void> {
  return invoke<void>("write_file", { path, contents });
}

export function createFile(path: string): Promise<void> {
  return invoke<void>("create_file", { path });
}

export function createDir(path: string): Promise<void> {
  return invoke<void>("create_dir", { path });
}

export function renamePath(from: string, to: string): Promise<void> {
  return invoke<void>("rename_path", { from, to });
}

export function deletePath(path: string): Promise<void> {
  return invoke<void>("delete_path", { path });
}

export function listFilesRecursive(root: string, max?: number): Promise<string[]> {
  return invoke<string[]>("list_files_recursive", { root, max });
}
