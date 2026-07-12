import { invoke } from "@tauri-apps/api/core";

export type ChangeKind =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "typechange";

export interface FileEntry {
  path: string;
  kind: ChangeKind;
  additions: number;
  deletions: number;
}

export interface RepoStatus {
  staged: FileEntry[];
  unstaged: FileEntry[];
  untracked: string[];
}

export function openRepo(path: string): Promise<string> {
  return invoke<string>("open_repo", { path });
}

export function getRepoStatus(): Promise<RepoStatus> {
  return invoke<RepoStatus>("get_repo_status");
}

export interface FileContentsResponse {
  name: string;
  old_content: string | null;
  old_binary: boolean;
  new_content: string | null;
  new_binary: boolean;
}

export interface FileContentsRequest {
  path: string;
  staged: boolean;
}

export interface FileContentsBatchItem {
  path: string;
  response: FileContentsResponse | null;
  error: string | null;
}

export function getFileContentsBatch(
  requests: FileContentsRequest[],
): Promise<FileContentsBatchItem[]> {
  return invoke<FileContentsBatchItem[]>("get_file_contents_batch", { requests });
}

export function stageFile(path: string): Promise<void> {
  return invoke<void>("stage_file", { path });
}

export function stageAll(): Promise<void> {
  return invoke<void>("stage_all");
}

export function unstageFile(path: string): Promise<void> {
  return invoke<void>("unstage_file", { path });
}

export function unstageAll(): Promise<void> {
  return invoke<void>("unstage_all");
}

export interface CommitOptions {
  amend?: boolean;
}

export function commit(
  message: string,
  options?: CommitOptions,
): Promise<string> {
  return invoke<string>("commit", { message, amend: options?.amend ?? false });
}

export function getRepoBranch(path: string): Promise<string | null> {
  return invoke<string | null>("get_repo_branch", { path });
}

export function discardFile(path: string): Promise<void> {
  return invoke<void>("discard_file", { path });
}

export function getLaunchPath(): Promise<string | null> {
  return invoke<string | null>("get_launch_path");
}

export interface BranchInfo {
  name: string;
  is_current: boolean;
}

export function listBranches(): Promise<BranchInfo[]> {
  return invoke<BranchInfo[]>("list_branches");
}

export function checkoutBranch(name: string): Promise<void> {
  return invoke<void>("checkout_branch", { name });
}
