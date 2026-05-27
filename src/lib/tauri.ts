import { invoke } from "@tauri-apps/api/core";
import type { ReviewComment } from "@/types/comments";
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

export interface CommentIdMapping {
  key: string;
  id: string;
}

export interface SubmitReviewResponse {
  submitted_count: number;
  comment_ids: CommentIdMapping[];
}

export function submitReview(
  comments: ReviewComment[],
): Promise<SubmitReviewResponse> {
  return invoke<SubmitReviewResponse>("submit_review", { comments });
}

export interface CloneProgress {
  id: string;
  phase: "fetch" | "checkout";
  received_objects: number;
  total_objects: number;
  indexed_objects: number;
  received_bytes: number;
  checkout_current: number;
  checkout_total: number;
}

export function cloneRepo(args: {
  url: string;
  dest: string;
  id: string;
}): Promise<string> {
  return invoke<string>("clone_repo", args);
}

export function cancelClone(id: string): Promise<void> {
  return invoke<void>("cancel_clone", { id });
}

export function cleanupPath(path: string): Promise<void> {
  return invoke<void>("cleanup_path", { path });
}

export function initRepo(path: string): Promise<string> {
  return invoke<string>("init_repo", { path });
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

export interface BranchDiff {
  base_ref: string;
  base_oid: string;
  head_oid: string;
  files: FileEntry[];
}

export function getBranchDiff(): Promise<BranchDiff | null> {
  return invoke<BranchDiff | null>("get_branch_diff");
}

export function getBranchFileContentsBatch(args: {
  baseOid: string;
  headOid: string;
  requests: string[];
}): Promise<FileContentsBatchItem[]> {
  return invoke<FileContentsBatchItem[]>("get_branch_file_contents_batch", {
    baseOid: args.baseOid,
    headOid: args.headOid,
    requests: args.requests,
  });
}

export const COMMIT_HISTORY_CHUNK_EVENT = "commit-history:chunk";
export const COMMIT_HISTORY_DONE_EVENT = "commit-history:done";
export const COMMIT_HISTORY_ERROR_EVENT = "commit-history:error";

export interface HeadState {
  branch: string | null;
  head_oid: string;
}

export interface CommitDetails {
  oid: string;
  subject: string;
  body: string;
  author_name: string;
  author_email: string;
  author_timestamp: number;
  committer_name: string;
  committer_email: string;
  committer_timestamp: number;
}

export interface CommitDiff {
  parent_oid: string | null;
  files: FileEntry[];
}

export interface CommitGraphRow {
  oid: string;
  parents: string[];
  refs: string[];
}

export interface ListCommitsStreamAck {
  request_id: string;
  total_estimate: number | null;
}

export interface CommitHistoryChunkPayload {
  request_id: string;
  oids: CommitGraphRow[];
}

export interface CommitHistoryDonePayload {
  request_id: string;
}

export interface CommitHistoryErrorPayload {
  request_id: string;
  message: string;
}

export function getHeadState(): Promise<HeadState> {
  return invoke<HeadState>("get_head_state");
}

export function getCommitDetailsBatch(oids: string[]): Promise<CommitDetails[]> {
  return invoke<CommitDetails[]>("get_commit_details_batch", { oids });
}

export function getCommitDiff(oid: string): Promise<CommitDiff> {
  return invoke<CommitDiff>("get_commit_diff", { oid });
}

export function getRootCommitFileContentsBatch(args: {
  oid: string;
  requests: string[];
}): Promise<FileContentsBatchItem[]> {
  return invoke<FileContentsBatchItem[]>("get_root_commit_file_contents_batch", {
    oid: args.oid,
    requests: args.requests,
  });
}

export function listCommitsStream(args: {
  branch: string | null;
  requestId: string;
}): Promise<ListCommitsStreamAck> {
  return invoke<ListCommitsStreamAck>("list_commits_stream", {
    branch: args.branch,
    requestId: args.requestId,
  });
}