use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Instant;

use git2::build::CheckoutBuilder;
use git2::{BranchType, Index, Patch, Repository, Status, StatusOptions, Tree};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, State};

// Temporary perf instrumentation. Emits perf:log events to the frontend and
// also prints to stderr so logs show up in the terminal that launched the
// Tauri process. Remove once the lag investigation is done.
fn perf_event(app: &AppHandle, op: &str, extra: serde_json::Value) {
    eprintln!("[maincode-perf] rust:{op} {extra}");
    let mut payload = match extra {
        serde_json::Value::Object(m) => m,
        _ => serde_json::Map::new(),
    };
    payload.insert("op".to_string(), serde_json::Value::String(op.to_string()));
    let _ = app.emit("perf:log", serde_json::Value::Object(payload));
}

fn ms_since(start: Instant) -> f64 {
    let d = start.elapsed();
    (d.as_secs_f64() * 1000.0 * 100.0).round() / 100.0
}

/// State for a single editor window: its open repository and file watcher.
#[derive(Default)]
pub struct WindowState {
    pub repo: Mutex<Option<Repository>>,
    pub watcher: Mutex<Option<crate::watcher::RepoWatcher>>,
    pub watcher_generation: AtomicU64,
}

/// App-wide state: one `WindowState` per window, keyed by the window label.
/// Each `WindowState` carries its own locks so a slow git op in one window
/// never blocks another; the map lock is only held to look up (or create) the
/// per-window `Arc`.
#[derive(Default)]
pub struct AppState {
    pub windows: Mutex<HashMap<String, Arc<WindowState>>>,
}

impl AppState {
    /// Get (or lazily create) the state for `label`.
    pub fn window(&self, label: &str) -> Arc<WindowState> {
        let mut map = self.windows.lock().expect("windows lock poisoned");
        map.entry(label.to_string())
            .or_insert_with(|| Arc::new(WindowState::default()))
            .clone()
    }

    /// Drop a window's state (dropping its watcher). Called when a window closes.
    pub fn remove_window(&self, label: &str) {
        if let Ok(mut map) = self.windows.lock() {
            map.remove(label);
        }
    }
}

fn restart_watcher(app: &AppHandle, ws: &Arc<WindowState>, label: &str, workdir: &Path) {
    let generation = ws.watcher_generation.fetch_add(1, Ordering::SeqCst) + 1;
    if let Ok(mut guard) = ws.watcher.lock() {
        *guard = None;
    }

    let workdir = workdir.to_path_buf();
    let app = app.clone();
    let ws = ws.clone();
    let label = label.to_string();
    thread::spawn(move || match crate::watcher::start(&workdir, app, label) {
        Ok(watcher) => {
            // A newer open_repo for this window may have bumped the generation
            // while we were starting; if so, discard this watcher.
            if ws.watcher_generation.load(Ordering::SeqCst) != generation {
                return;
            }
            if let Ok(mut guard) = ws.watcher.lock() {
                if ws.watcher_generation.load(Ordering::SeqCst) == generation {
                    *guard = Some(watcher);
                }
            }
        }
        Err(e) => eprintln!("[maincode-watcher] failed to start: {e}"),
    });
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "snake_case")]
pub enum ChangeKind {
    Added,
    Modified,
    Deleted,
    Renamed,
    Typechange,
}

#[derive(Serialize, Clone)]
pub struct FileEntry {
    pub path: String,
    pub kind: ChangeKind,
    pub additions: u32,
    pub deletions: u32,
}

#[derive(Serialize)]
pub struct RepoStatus {
    pub staged: Vec<FileEntry>,
    pub unstaged: Vec<FileEntry>,
    pub untracked: Vec<String>,
}

enum CountDiffKind {
    /// HEAD tree → index.
    StagedAgainstHead(Option<git2::Oid>),
    /// index → workdir.
    Unstaged,
}

fn build_diff_for_count<'a>(
    repo: &'a Repository,
    kind: &CountDiffKind,
) -> Result<git2::Diff<'a>, git2::Error> {
    match kind {
        CountDiffKind::StagedAgainstHead(tree_oid) => {
            let tree = tree_oid.and_then(|oid| repo.find_tree(oid).ok());
            repo.diff_tree_to_index(tree.as_ref(), None, None)
        }
        CountDiffKind::Unstaged => repo.diff_index_to_workdir(None, None),
    }
}

/// Compute per-file `(additions, deletions)` for a diff in parallel. Each
/// worker opens its own `Repository` and re-creates the diff (cheap: ~ms),
/// then computes `Patch::from_diff` on its slice of delta indexes. git2's
/// `Diff` is `!Send`/`!Sync`, so this is the only way to split xdiff work
/// across cores — which matters because xdiff for 600+ files is CPU-bound
/// and was pinning a single core at ~300ms.
fn count_diff_lines_parallel(
    workdir: &Path,
    kind: CountDiffKind,
    delta_count: usize,
) -> HashMap<String, (u32, u32)> {
    if delta_count == 0 {
        return HashMap::new();
    }
    let num_threads = std::thread::available_parallelism()
        .map(|n| n.get().min(8))
        .unwrap_or(4)
        .min(delta_count);
    let chunk_size = delta_count.div_ceil(num_threads);
    let kind_ref = &kind;

    std::thread::scope(|s| {
        let handles: Vec<_> = (0..delta_count)
            .step_by(chunk_size)
            .map(|start| {
                let end = (start + chunk_size).min(delta_count);
                s.spawn(move || -> HashMap<String, (u32, u32)> {
                    let Ok(repo) = Repository::open(workdir) else {
                        return HashMap::new();
                    };
                    let Ok(diff) = build_diff_for_count(&repo, kind_ref) else {
                        return HashMap::new();
                    };
                    let mut counts = HashMap::new();
                    for idx in start..end {
                        let Some(delta) = diff.get_delta(idx) else {
                            continue;
                        };
                        let Some(path) = delta
                            .new_file()
                            .path()
                            .or_else(|| delta.old_file().path())
                            .and_then(|p| p.to_str())
                            .map(str::to_owned)
                        else {
                            continue;
                        };
                        let Ok(Some(patch)) = Patch::from_diff(&diff, idx) else {
                            continue;
                        };
                        let Ok((_, adds, dels)) = patch.line_stats() else {
                            continue;
                        };
                        counts.insert(
                            path,
                            (
                                u32::try_from(adds).unwrap_or(u32::MAX),
                                u32::try_from(dels).unwrap_or(u32::MAX),
                            ),
                        );
                    }
                    counts
                })
            })
            .collect();

        let mut merged = HashMap::with_capacity(delta_count);
        for handle in handles {
            if let Ok(map) = handle.join() {
                merged.extend(map);
            }
        }
        merged
    })
}

#[tauri::command]
pub fn open_repo(
    path: String,
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<AppState>,
) -> Result<String, String> {
    let ws = state.window(window.label());
    let total_start = Instant::now();
    perf_event(&app, "open_repo:start", json!({ "path": &path }));

    let discover_start = Instant::now();
    let repo = match Repository::discover(&path) {
        Ok(repo) => repo,
        Err(e) => {
            perf_event(
                &app,
                "open_repo:error",
                json!({
                    "path": &path,
                    "phase": "discover",
                    "discoverMs": ms_since(discover_start),
                    "totalMs": ms_since(total_start),
                    "error": e.to_string(),
                }),
            );
            return Err(format!("failed to open repo: {e}"));
        }
    };
    let discover_ms = ms_since(discover_start);

    let workdir_start = Instant::now();
    let workdir_path = match repo.workdir() {
        Some(workdir) => workdir.to_path_buf(),
        None => {
            perf_event(
                &app,
                "open_repo:error",
                json!({
                    "path": &path,
                    "phase": "workdir",
                    "discoverMs": discover_ms,
                    "workdirMs": ms_since(workdir_start),
                    "totalMs": ms_since(total_start),
                    "error": "bare repositories are not supported",
                }),
            );
            return Err("bare repositories are not supported".to_string());
        }
    };
    let workdir_ms = ms_since(workdir_start);
    let workdir = workdir_path.to_string_lossy().to_string();

    let lock_start = Instant::now();
    let mut guard = match ws.repo.lock() {
        Ok(guard) => guard,
        Err(e) => {
            perf_event(
                &app,
                "open_repo:error",
                json!({
                    "path": &path,
                    "workdir": &workdir,
                    "phase": "lock",
                    "discoverMs": discover_ms,
                    "workdirMs": workdir_ms,
                    "lockWaitMs": ms_since(lock_start),
                    "totalMs": ms_since(total_start),
                    "error": e.to_string(),
                }),
            );
            return Err(format!("lock poisoned: {e}"));
        }
    };
    let lock_wait_ms = ms_since(lock_start);

    let state_set_start = Instant::now();
    *guard = Some(repo);
    drop(guard);
    let state_set_ms = ms_since(state_set_start);

    let watcher_start = Instant::now();
    restart_watcher(&app, &ws, window.label(), &workdir_path);
    let watcher_spawn_ms = ms_since(watcher_start);

    perf_event(
        &app,
        "open_repo",
        json!({
            "path": &path,
            "workdir": &workdir,
            "totalMs": ms_since(total_start),
            "discoverMs": discover_ms,
            "workdirMs": workdir_ms,
            "lockWaitMs": lock_wait_ms,
            "stateSetMs": state_set_ms,
            "watcherSpawnMs": watcher_spawn_ms,
        }),
    );
    Ok(workdir)
}

#[tauri::command]
pub fn get_repo_status(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<AppState>,
) -> Result<RepoStatus, String> {
    let ws = state.window(window.label());
    let total_start = Instant::now();
    let (
        status_entries,
        statuses_count,
        staged_counts,
        unstaged_counts,
        lock_ms,
        statuses_ms,
        staged_diff_ms,
        unstaged_diff_ms,
        staged_count_ms,
        unstaged_count_ms,
    ) = {
        let lock_start = Instant::now();
        let lock = ws
            .repo
            .lock()
            .map_err(|e| format!("lock poisoned: {e}"))?;
        let lock_ms = ms_since(lock_start);
        let repo = lock.as_ref().ok_or("no repository open")?;
        let workdir_path = repo.workdir().ok_or("bare repository")?.to_path_buf();

        let mut opts = StatusOptions::new();
        opts.include_untracked(true).recurse_untracked_dirs(true);

        let statuses_start = Instant::now();
        let statuses = repo
            .statuses(Some(&mut opts))
            .map_err(|e| format!("failed to get status: {e}"))?;
        let statuses_ms = ms_since(statuses_start);
        let statuses_count = statuses.len();
        let status_entries: Vec<(String, Status)> = statuses
            .iter()
            .filter_map(|entry| entry.path().map(|p| (p.to_string(), entry.status())))
            .collect();

        let head_tree = repo
            .revparse_single("HEAD^{tree}")
            .ok()
            .and_then(|obj| obj.into_tree().ok());
        let head_tree_oid = head_tree.as_ref().map(|t| t.id());

        let staged_diff_start = Instant::now();
        let staged_diff = repo
            .diff_tree_to_index(head_tree.as_ref(), None, None)
            .map_err(|e| format!("failed to diff staged: {e}"))?;
        let staged_diff_ms = ms_since(staged_diff_start);
        let staged_delta_count = staged_diff.deltas().count();

        let unstaged_diff_start = Instant::now();
        let unstaged_diff = repo
            .diff_index_to_workdir(None, None)
            .map_err(|e| format!("failed to diff unstaged: {e}"))?;
        let unstaged_diff_ms = ms_since(unstaged_diff_start);
        let unstaged_delta_count = unstaged_diff.deltas().count();

        // Count line stats while holding the repo lock so a concurrent
        // `open_repo` cannot swap `state.repo` and let a stale snapshot land
        // on top of a freshly opened repository.
        let staged_count_start = Instant::now();
        let staged_counts = count_diff_lines_parallel(
            &workdir_path,
            CountDiffKind::StagedAgainstHead(head_tree_oid),
            staged_delta_count,
        );
        let staged_count_ms = ms_since(staged_count_start);

        let unstaged_count_start = Instant::now();
        let unstaged_counts =
            count_diff_lines_parallel(&workdir_path, CountDiffKind::Unstaged, unstaged_delta_count);
        let unstaged_count_ms = ms_since(unstaged_count_start);

        (
            status_entries,
            statuses_count,
            staged_counts,
            unstaged_counts,
            lock_ms,
            statuses_ms,
            staged_diff_ms,
            unstaged_diff_ms,
            staged_count_ms,
            unstaged_count_ms,
        )
    };

    let mut staged = Vec::new();
    let mut unstaged = Vec::new();
    let mut untracked = Vec::new();

    let classify_start = Instant::now();
    for (path, s) in status_entries {
        if s.intersects(
            git2::Status::INDEX_NEW
                | git2::Status::INDEX_MODIFIED
                | git2::Status::INDEX_DELETED
                | git2::Status::INDEX_RENAMED
                | git2::Status::INDEX_TYPECHANGE,
        ) {
            let kind = if s.contains(git2::Status::INDEX_NEW) {
                ChangeKind::Added
            } else if s.contains(git2::Status::INDEX_MODIFIED) {
                ChangeKind::Modified
            } else if s.contains(git2::Status::INDEX_DELETED) {
                ChangeKind::Deleted
            } else if s.contains(git2::Status::INDEX_RENAMED) {
                ChangeKind::Renamed
            } else {
                ChangeKind::Typechange
            };
            let (additions, deletions) = staged_counts.get(&path).copied().unwrap_or((0, 0));
            staged.push(FileEntry {
                path: path.clone(),
                kind,
                additions,
                deletions,
            });
        }

        if s.intersects(
            git2::Status::WT_MODIFIED
                | git2::Status::WT_DELETED
                | git2::Status::WT_RENAMED
                | git2::Status::WT_TYPECHANGE,
        ) {
            let kind = if s.contains(git2::Status::WT_MODIFIED) {
                ChangeKind::Modified
            } else if s.contains(git2::Status::WT_DELETED) {
                ChangeKind::Deleted
            } else if s.contains(git2::Status::WT_RENAMED) {
                ChangeKind::Renamed
            } else {
                ChangeKind::Typechange
            };
            let (additions, deletions) = unstaged_counts.get(&path).copied().unwrap_or((0, 0));
            unstaged.push(FileEntry {
                path: path.clone(),
                kind,
                additions,
                deletions,
            });
        }

        if s.contains(git2::Status::WT_NEW) {
            untracked.push(path);
        }
    }
    let classify_ms = ms_since(classify_start);

    perf_event(
        &app,
        "get_repo_status",
        json!({
            "totalMs": ms_since(total_start),
            "lockWaitMs": lock_ms,
            "statusesMs": statuses_ms,
            "statusesCount": statuses_count,
            "stagedDiffMs": staged_diff_ms,
            "stagedCountLinesMs": staged_count_ms,
            "stagedFiles": staged.len(),
            "unstagedDiffMs": unstaged_diff_ms,
            "unstagedCountLinesMs": unstaged_count_ms,
            "unstagedFiles": unstaged.len(),
            "untrackedFiles": untracked.len(),
            "classifyMs": classify_ms,
        }),
    );

    Ok(RepoStatus {
        staged,
        unstaged,
        untracked,
    })
}

/// Return the old (HEAD) and new (workdir) contents of a file for client-side diffing.
/// This gives `@pierre/diffs` `parseDiffFromFile` full file contents so hunk
/// expansion and custom hunk separators work correctly.
#[derive(Serialize)]
pub struct FileContentsResponse {
    pub name: String,
    /// None when the file is absent on the HEAD side.
    pub old_content: Option<String>,
    /// True when the HEAD side exists but is not valid UTF-8 text.
    pub old_binary: bool,
    /// None when the file is absent on the workdir side.
    pub new_content: Option<String>,
    /// True when the workdir side exists but is not valid UTF-8 text.
    pub new_binary: bool,
}

#[derive(Deserialize)]
pub struct FileContentsRequest {
    pub path: String,
    pub staged: bool,
}

#[derive(Serialize)]
pub struct FileContentsBatchItem {
    pub path: String,
    pub response: Option<FileContentsResponse>,
    pub error: Option<String>,
}

struct FileSideContent {
    content: Option<String>,
    is_binary: bool,
}

impl FileSideContent {
    /// File is absent from this side (no tree entry, or file doesn't exist on disk).
    fn absent() -> Self {
        Self {
            content: None,
            is_binary: false,
        }
    }
}

fn decode_file_side(bytes: &[u8]) -> FileSideContent {
    match std::str::from_utf8(bytes) {
        Ok(text) => FileSideContent {
            content: Some(text.to_owned()),
            is_binary: false,
        },
        Err(_) => FileSideContent {
            content: None,
            is_binary: true,
        },
    }
}

fn read_head_tree(repo: &Repository) -> Option<Tree<'_>> {
    repo.revparse_single("HEAD^{tree}")
        .ok()
        .and_then(|obj| obj.into_tree().ok())
}

fn read_tree_file(
    repo: &Repository,
    tree: Option<&Tree<'_>>,
    path: &Path,
) -> Result<FileSideContent, String> {
    let Some(tree) = tree else {
        return Ok(FileSideContent::absent());
    };

    let Ok(entry) = tree.get_path(path) else {
        return Ok(FileSideContent::absent());
    };

    let object = entry
        .to_object(repo)
        .map_err(|e| format!("cannot read HEAD object for {}: {e}", path.display()))?;
    let blob = object
        .into_blob()
        .map_err(|_| format!("HEAD entry for {} is not a blob", path.display()))?;

    Ok(decode_file_side(blob.content()))
}

fn validate_repo_relative_path(path: &Path) -> Result<(), String> {
    for component in path.components() {
        match component {
            Component::Normal(_) | Component::CurDir => {}
            _ => return Err(format!("invalid path: {}", path.display())),
        }
    }
    Ok(())
}

fn read_workdir_file(workdir: &Path, path: &Path) -> Result<FileSideContent, String> {
    // Reject anything other than normal/cur-dir components so we never escape
    // the workdir. Avoids the per-file `canonicalize()` (5+ stat syscalls per
    // path) that previously dominated `get_file_contents_batch:readMs`.
    validate_repo_relative_path(path)?;

    let abs = workdir.join(path);
    // Component filter blocks `..` but not symlinks; a tracked file like
    // `evil.txt -> /etc/passwd` would otherwise be followed by `fs::read`.
    let meta = match std::fs::symlink_metadata(&abs) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(FileSideContent::absent());
        }
        Err(e) => return Err(format!("cannot stat {}: {e}", path.display())),
    };
    if meta.file_type().is_symlink() {
        return Err(format!("symlink not permitted: {}", path.display()));
    }
    match std::fs::read(&abs) {
        Ok(bytes) => Ok(decode_file_side(&bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(FileSideContent::absent()),
        Err(e) => Err(format!("cannot read {}: {e}", path.display())),
    }
}

fn read_index_file(
    repo: &Repository,
    index: &Index,
    path: &Path,
) -> Result<FileSideContent, String> {
    let entry = match index.get_path(path, 0) {
        Some(e) => e,
        None => return Ok(FileSideContent::absent()),
    };
    let blob = repo
        .find_blob(entry.id)
        .map_err(|e| format!("cannot read index blob for {}: {e}", path.display()))?;
    Ok(decode_file_side(blob.content()))
}

#[tauri::command]
pub fn get_file_contents_batch(
    requests: Vec<FileContentsRequest>,
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<AppState>,
) -> Result<Vec<FileContentsBatchItem>, String> {
    let ws = state.window(window.label());
    let total_start = Instant::now();
    let requested_count = requests.len();
    let lock_start = Instant::now();
    let lock = ws
        .repo
        .lock()
        .map_err(|e| format!("lock poisoned: {e}"))?;
    let lock_ms = ms_since(lock_start);
    let repo = lock.as_ref().ok_or("no repository open")?;

    let setup_start = Instant::now();
    let workdir_path = repo.workdir().ok_or("bare repository")?.to_path_buf();
    let head_tree_oid = read_head_tree(repo).map(|t| t.id());
    let needs_index = requests.iter().any(|request| request.staged);
    let needs_workdir = requests.iter().any(|request| !request.staged);
    let setup_ms = ms_since(setup_start);

    // Release the global repo lock before the parallel read phase. Workers
    // open their own Repository handles; holding the lock here serializes
    // every other git2 command (refresh, stage, watcher-triggered refresh).
    drop(lock);
    let workdir: &Path = &workdir_path;

    let read_start = Instant::now();

    // Parallelize file reads across cores. git2's Repository/Index/Tree are
    // `!Send`, so each worker opens its own Repository (cheap: ~ms) and reads
    // its slice of files. For 600+ requests this turns ~220ms of sequential
    // I/O + blob lookups into ~50–80ms of parallel work on an 8-core box.
    let num_threads = std::thread::available_parallelism()
        .map(|n| n.get().min(8))
        .unwrap_or(4)
        .min(requested_count.max(1));
    let chunk_size = requested_count.div_ceil(num_threads.max(1));

    let responses: Vec<FileContentsBatchItem> = if requested_count == 0 {
        Vec::new()
    } else {
        std::thread::scope(|s| {
            let handles: Vec<_> = requests
                .chunks(chunk_size)
                .map(|chunk| {
                    s.spawn(move || -> Vec<FileContentsBatchItem> {
                        let repo = match Repository::open(workdir) {
                            Ok(r) => r,
                            Err(e) => {
                                return chunk
                                    .iter()
                                    .map(|r| FileContentsBatchItem {
                                        path: r.path.clone(),
                                        response: None,
                                        error: Some(format!("worker repo open failed: {e}")),
                                    })
                                    .collect();
                            }
                        };
                        let head_tree = head_tree_oid.and_then(|oid| repo.find_tree(oid).ok());
                        let chunk_needs_index = chunk.iter().any(|r| r.staged);
                        let index = if chunk_needs_index {
                            repo.index().ok()
                        } else {
                            None
                        };

                        let mut out = Vec::with_capacity(chunk.len());
                        for request in chunk {
                            let path = request.path.clone();
                            let staged = request.staged;
                            let relative_path = Path::new(&path);
                            let result = (|| -> Result<FileContentsResponse, String> {
                                let old_side =
                                    read_tree_file(&repo, head_tree.as_ref(), relative_path)?;
                                let new_side = if staged {
                                    read_index_file(
                                        &repo,
                                        index.as_ref().ok_or("index unavailable")?,
                                        relative_path,
                                    )?
                                } else {
                                    read_workdir_file(workdir, relative_path)?
                                };
                                Ok(FileContentsResponse {
                                    name: path.clone(),
                                    old_content: old_side.content,
                                    old_binary: old_side.is_binary,
                                    new_content: new_side.content,
                                    new_binary: new_side.is_binary,
                                })
                            })();
                            out.push(match result {
                                Ok(response) => FileContentsBatchItem {
                                    path,
                                    response: Some(response),
                                    error: None,
                                },
                                Err(error) => FileContentsBatchItem {
                                    path,
                                    response: None,
                                    error: Some(error),
                                },
                            });
                        }
                        out
                    })
                })
                .collect();

            let mut all = Vec::with_capacity(requested_count);
            for handle in handles {
                if let Ok(chunk) = handle.join() {
                    all.extend(chunk);
                }
            }
            all
        })
    };

    let read_ms = ms_since(read_start);
    let ok_count = responses.iter().filter(|r| r.response.is_some()).count();
    let err_count = responses.len().saturating_sub(ok_count);

    perf_event(
        &app,
        "get_file_contents_batch",
        json!({
            "requested": requested_count,
            "ok": ok_count,
            "errors": err_count,
            "stagedRequests": needs_index,
            "workdirRequests": needs_workdir,
            "lockWaitMs": lock_ms,
            "setupMs": setup_ms,
            "readMs": read_ms,
            "totalMs": ms_since(total_start),
        }),
    );

    Ok(responses)
}

fn stage_path(repo: &Repository, path: &str) -> Result<(), String> {
    let input_path = Path::new(path);
    validate_repo_relative_path(input_path)?;
    let mut repo_path = PathBuf::new();
    for component in input_path.components() {
        if let Component::Normal(part) = component {
            repo_path.push(part);
        }
    }

    let is_directory_path = path.ends_with('/');
    let workdir = repo.workdir().ok_or("bare repository")?;
    let target = workdir.join(&repo_path);

    let mut index = repo
        .index()
        .map_err(|e| format!("failed to get index: {e}"))?;

    if is_directory_path || target.is_dir() {
        let paths = collect_status_paths(
            repo,
            Status::WT_NEW
                | Status::WT_MODIFIED
                | Status::WT_DELETED
                | Status::WT_RENAMED
                | Status::WT_TYPECHANGE,
            (!repo_path.as_os_str().is_empty()).then_some(repo_path.as_path()),
        )?;

        for (path, status) in paths {
            let child_path = Path::new(&path);
            if child_path == repo_path || !child_path.starts_with(&repo_path) {
                continue;
            }

            stage_index_path(&mut index, workdir, child_path, Some(status))?;
        }

        index
            .write()
            .map_err(|e| format!("failed to write index: {e}"))?;

        return Ok(());
    }

    stage_index_path(
        &mut index,
        workdir,
        &repo_path,
        repo.status_file(&repo_path).ok(),
    )?;

    index
        .write()
        .map_err(|e| format!("failed to write index: {e}"))?;

    Ok(())
}

fn stage_index_path(
    index: &mut Index,
    workdir: &Path,
    repo_path: &Path,
    status: Option<Status>,
) -> Result<(), String> {
    if workdir.join(repo_path).exists() {
        index
            .add_path(repo_path)
            .map_err(|e| format!("failed to stage file: {e}"))?;
        return Ok(());
    }

    let Some(status) = status else {
        return Ok(());
    };

    if !status.intersects(
        Status::WT_DELETED
            | Status::WT_RENAMED
            | Status::WT_TYPECHANGE
            | Status::INDEX_DELETED
            | Status::INDEX_RENAMED
            | Status::INDEX_TYPECHANGE,
    ) {
        return Ok(());
    }

    index
        .remove_path(repo_path)
        .map_err(|e| format!("failed to stage file: {e}"))?;
    Ok(())
}

fn unstage_path(repo: &Repository, path: &str) -> Result<(), String> {
    let head_result = repo.revparse_single("HEAD");

    match head_result {
        Ok(head_obj) => {
            repo.reset_default(Some(&head_obj), [path])
                .map_err(|e| format!("failed to unstage file: {e}"))?;
        }
        Err(_) => {
            // No HEAD yet (initial commit) — remove from index directly
            let mut index = repo
                .index()
                .map_err(|e| format!("failed to get index: {e}"))?;
            index
                .remove_path(Path::new(path))
                .map_err(|e| format!("failed to unstage file: {e}"))?;
            index
                .write()
                .map_err(|e| format!("failed to write index: {e}"))?;
        }
    }

    Ok(())
}

fn collect_status_paths(
    repo: &Repository,
    flags: Status,
    pathspec: Option<&Path>,
) -> Result<Vec<(String, Status)>, String> {
    let mut opts = StatusOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true);
    if let Some(pathspec) = pathspec {
        opts.pathspec(pathspec).disable_pathspec_match(true);
    }

    let statuses = repo
        .statuses(Some(&mut opts))
        .map_err(|e| format!("failed to get status: {e}"))?;

    let mut paths = Vec::new();
    for entry in statuses.iter() {
        if entry.status().intersects(flags) {
            if let Some(path) = entry.path() {
                paths.push((path.to_string(), entry.status()));
            }
        }
    }

    paths.sort_by(|a, b| a.0.cmp(&b.0));
    paths.dedup_by(|a, b| a.0 == b.0);
    Ok(paths)
}

fn collect_paths(repo: &Repository, flags: Status) -> Result<Vec<String>, String> {
    collect_status_paths(repo, flags, None)
        .map(|paths| paths.into_iter().map(|(path, _)| path).collect::<Vec<_>>())
}

#[tauri::command]
pub fn stage_file(
    path: String,
    window: tauri::WebviewWindow,
    state: State<AppState>,
) -> Result<(), String> {
    let ws = state.window(window.label());
    let lock = ws
        .repo
        .lock()
        .map_err(|e| format!("lock poisoned: {e}"))?;
    let repo = lock.as_ref().ok_or("no repository open")?;

    stage_path(repo, &path)
}

#[tauri::command]
pub fn stage_all(window: tauri::WebviewWindow, state: State<AppState>) -> Result<(), String> {
    let ws = state.window(window.label());
    let lock = ws
        .repo
        .lock()
        .map_err(|e| format!("lock poisoned: {e}"))?;
    let repo = lock.as_ref().ok_or("no repository open")?;

    let paths = collect_status_paths(
        repo,
        Status::WT_NEW
            | Status::WT_MODIFIED
            | Status::WT_DELETED
            | Status::WT_RENAMED
            | Status::WT_TYPECHANGE,
        None,
    )?;

    let workdir = repo.workdir().ok_or("bare repository")?;

    let mut index = repo
        .index()
        .map_err(|e| format!("failed to get index: {e}"))?;

    for (path, status) in paths {
        let repo_path = Path::new(&path);
        stage_index_path(&mut index, workdir, repo_path, Some(status))?;
    }

    index
        .write()
        .map_err(|e| format!("failed to write index: {e}"))?;

    Ok(())
}

#[tauri::command]
pub fn unstage_file(
    path: String,
    window: tauri::WebviewWindow,
    state: State<AppState>,
) -> Result<(), String> {
    let ws = state.window(window.label());
    let lock = ws
        .repo
        .lock()
        .map_err(|e| format!("lock poisoned: {e}"))?;
    let repo = lock.as_ref().ok_or("no repository open")?;

    unstage_path(repo, &path)
}

#[tauri::command]
pub fn unstage_all(window: tauri::WebviewWindow, state: State<AppState>) -> Result<(), String> {
    let ws = state.window(window.label());
    let lock = ws
        .repo
        .lock()
        .map_err(|e| format!("lock poisoned: {e}"))?;
    let repo = lock.as_ref().ok_or("no repository open")?;

    for path in collect_paths(
        repo,
        Status::INDEX_NEW
            | Status::INDEX_MODIFIED
            | Status::INDEX_DELETED
            | Status::INDEX_RENAMED
            | Status::INDEX_TYPECHANGE,
    )? {
        unstage_path(repo, &path)?;
    }

    Ok(())
}

#[tauri::command]
pub fn discard_file(
    path: String,
    window: tauri::WebviewWindow,
    state: State<AppState>,
) -> Result<(), String> {
    let ws = state.window(window.label());
    let lock = ws
        .repo
        .lock()
        .map_err(|e| format!("lock poisoned: {e}"))?;
    let repo = lock.as_ref().ok_or("no repository open")?;
    let workdir = repo.workdir().ok_or("bare repository")?;

    let relative_path = Path::new(&path);
    validate_repo_relative_path(relative_path)?;
    // Containment check: `validate_repo_relative_path` only rejects syntactic
    // `..`/absolute components; a symlinked parent inside the workdir would
    // otherwise let `checkout_head` or removal escape the repo. Canonicalize
    // workdir + (target or parent) and require `starts_with(canonical_workdir)`.
    let target = canonical_contained_target(workdir, relative_path)?;

    let status = repo
        .status_file(relative_path)
        .map_err(|e| format!("failed to status file: {e}"))?;
    let index_dirty = status.intersects(
        Status::INDEX_NEW
            | Status::INDEX_MODIFIED
            | Status::INDEX_DELETED
            | Status::INDEX_RENAMED
            | Status::INDEX_TYPECHANGE,
    );

    // Pure untracked file or directory: remove from disk, no git state to touch.
    if status.contains(Status::WT_NEW) && !index_dirty {
        remove_workdir_entry(&target)?;
        return Ok(());
    }

    // If index has uncommitted changes for this path, reset to HEAD first.
    if index_dirty {
        match repo.revparse_single("HEAD") {
            Ok(head_obj) => {
                repo.reset_default(Some(&head_obj), [&path])
                    .map_err(|e| format!("reset_default failed: {e}"))?;
            }
            Err(_) => {
                // No HEAD yet (initial commit): drop from index directly.
                let mut index = repo
                    .index()
                    .map_err(|e| format!("failed to get index: {e}"))?;
                let _ = index.remove_path(relative_path);
                index
                    .write()
                    .map_err(|e| format!("failed to write index: {e}"))?;
            }
        }
    }

    // Restore workdir from HEAD for that path, if HEAD exists.
    if repo.revparse_single("HEAD").is_ok() {
        let mut cb = CheckoutBuilder::new();
        cb.force();
        cb.path(&path);
        repo.checkout_head(Some(&mut cb))
            .map_err(|e| format!("checkout_head failed: {e}"))?;
    }

    // Staged-new with no HEAD counterpart: after reset the file is untracked. Remove it.
    if let Ok(post) = repo.status_file(relative_path) {
        let post_index_dirty = post.intersects(
            Status::INDEX_NEW
                | Status::INDEX_MODIFIED
                | Status::INDEX_DELETED
                | Status::INDEX_RENAMED
                | Status::INDEX_TYPECHANGE,
        );
        if post.contains(Status::WT_NEW) && !post_index_dirty {
            let _ = remove_workdir_entry(&target);
        }
    }

    Ok(())
}

// Single-stat removal: classify file-vs-dir-vs-missing atomically, then act.
// Avoids the TOCTOU `exists()` → `is_dir()` → `exists()` chain.
fn remove_workdir_entry(target: &Path) -> Result<(), String> {
    let meta = match std::fs::symlink_metadata(target) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("cannot stat {}: {e}", target.display())),
    };
    let ft = meta.file_type();
    if ft.is_dir() {
        std::fs::remove_dir_all(target).map_err(|e| format!("remove failed: {e}"))
    } else {
        std::fs::remove_file(target).map_err(|e| format!("remove failed: {e}"))
    }
}

fn canonical_contained_target(workdir: &Path, relative_path: &Path) -> Result<PathBuf, String> {
    let canonical_workdir = workdir
        .canonicalize()
        .map_err(|e| format!("cannot canonicalize workdir: {e}"))?;
    let target = canonical_workdir.join(relative_path);
    let safe_target = if target.exists() {
        target
            .canonicalize()
            .map_err(|e| format!("cannot canonicalize target: {e}"))?
    } else {
        let parent = target.parent().ok_or("invalid path")?;
        let parent_canonical = parent
            .canonicalize()
            .map_err(|e| format!("cannot canonicalize parent: {e}"))?;
        parent_canonical.join(target.file_name().unwrap_or_default())
    };
    if !safe_target.starts_with(&canonical_workdir) {
        return Err("path traversal detected".to_string());
    }
    Ok(safe_target)
}

#[tauri::command]
pub fn commit(
    message: String,
    amend: Option<bool>,
    window: tauri::WebviewWindow,
    state: State<AppState>,
) -> Result<String, String> {
    let ws = state.window(window.label());
    let lock = ws
        .repo
        .lock()
        .map_err(|e| format!("lock poisoned: {e}"))?;
    let repo = lock.as_ref().ok_or("no repository open")?;
    let amend = amend.unwrap_or(false);

    if message.trim().is_empty() {
        return Err("commit message cannot be empty".to_string());
    }

    let mut index = repo
        .index()
        .map_err(|e| format!("failed to get index: {e}"))?;

    let tree_oid = index
        .write_tree()
        .map_err(|e| format!("failed to write tree: {e}"))?;

    if !amend {
        // Reject empty commits (no changes staged)
        if let Ok(head_ref) = repo.head() {
            if let Ok(head_commit) = head_ref.peel_to_commit() {
                if head_commit.tree_id() == tree_oid {
                    return Err("nothing to commit: index matches HEAD".to_string());
                }
            }
        }
    }

    let tree = repo
        .find_tree(tree_oid)
        .map_err(|e| format!("failed to find tree: {e}"))?;

    let sig = repo
        .signature()
        .map_err(|e| format!("failed to get signature: {e}"))?;

    let oid = if amend {
        let head_ref = repo
            .head()
            .map_err(|_| "cannot amend: no commit to amend".to_string())?;
        let head_commit = head_ref
            .peel_to_commit()
            .map_err(|e| format!("failed to peel HEAD to commit: {e}"))?;
        head_commit
            .amend(
                Some("HEAD"),
                Some(&sig),
                Some(&sig),
                None,
                Some(&message),
                Some(&tree),
            )
            .map_err(|e| format!("failed to amend commit: {e}"))?
    } else {
        match repo.head() {
            Ok(head_ref) => {
                let parent = head_ref
                    .peel_to_commit()
                    .map_err(|e| format!("failed to peel HEAD to commit: {e}"))?;
                repo.commit(Some("HEAD"), &sig, &sig, &message, &tree, &[&parent])
                    .map_err(|e| format!("failed to create commit: {e}"))?
            }
            Err(_) => repo
                .commit(Some("HEAD"), &sig, &sig, &message, &tree, &[])
                .map_err(|e| format!("failed to create initial commit: {e}"))?,
        }
    };

    Ok(oid.to_string())
}

#[tauri::command]
pub fn get_repo_branch(path: String) -> Result<Option<String>, String> {
    let repo = Repository::discover(&path).map_err(|e| format!("open: {e}"))?;
    let head = match repo.head() {
        Ok(h) => h,
        Err(_) => return Ok(None),
    };
    Ok(head.shorthand().map(|s| s.to_string()))
}


#[derive(Serialize)]
pub struct BranchInfo {
    pub name: String,
    pub is_current: bool,
}

/// List local branches in the currently open repository, sorted by the
/// committer time of each branch's tip (most recent first). Branches whose
/// tip cannot be resolved fall to the bottom.
/// `is_current` is true for the branch HEAD currently points at (if any).
#[tauri::command]
pub fn list_branches(
    window: tauri::WebviewWindow,
    state: State<AppState>,
) -> Result<Vec<BranchInfo>, String> {
    let ws = state.window(window.label());
    let lock = ws.repo.lock().map_err(|e| format!("lock poisoned: {e}"))?;
    let repo = lock.as_ref().ok_or("no repository open")?;
    let head_name = repo
        .head()
        .ok()
        .and_then(|h| h.shorthand().map(|s| s.to_string()));
    let branches = repo
        .branches(Some(BranchType::Local))
        .map_err(|e| format!("branches: {e}"))?;
    let mut out: Vec<(BranchInfo, i64)> = Vec::new();
    for entry in branches {
        let (branch, _) = entry.map_err(|e| format!("branch entry: {e}"))?;
        if let Ok(Some(name)) = branch.name() {
            let name = name.to_string();
            let is_current = head_name.as_deref() == Some(name.as_str());
            let when = branch
                .get()
                .peel_to_commit()
                .map(|c| c.time().seconds())
                .unwrap_or(i64::MIN);
            out.push((BranchInfo { name, is_current }, when));
        }
    }
    out.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.name.cmp(&b.0.name)));
    Ok(out.into_iter().map(|(b, _)| b).collect())
}

/// Switch the currently open repository to a local branch. Refuses to clobber
/// uncommitted changes (git2 default "safe" checkout strategy).
#[tauri::command]
pub fn checkout_branch(
    name: String,
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<AppState>,
) -> Result<(), String> {
    let ws = state.window(window.label());
    let lock = ws.repo.lock().map_err(|e| format!("lock poisoned: {e}"))?;
    let repo = lock.as_ref().ok_or("no repository open")?;

    // Force a fresh read of `.git/index` into the cached in-memory index before
    // checkout. `state.repo` is held across the app's lifetime and external git
    // operations (terminal `git pull`, `git commit`, etc.) routinely leave the
    // cached index stale. libgit2's checkout does call `git_index_read_safely`
    // internally, but it bails on mtime equality — a same-second external
    // write can slip past it. Forcing `read(true)` guarantees the baseline
    // libgit2 uses to decide "is this file locally modified" matches reality.
    if let Ok(mut idx) = repo.index() {
        let _ = idx.read(true);
    }

    // Capture the original HEAD's tree so we can roll back the workdir+index if
    // `set_head` fails *after* `checkout_tree` has already written them.
    // libgit2 refuses to set HEAD to a branch checked out in a linked worktree
    // ("current HEAD of a linked repository"), but only after `checkout_tree`
    // has happily updated the workdir and index to the new branch's tree — the
    // exact "phantom staged changes" symptom users see.
    let original_head_tree_oid = repo
        .head()
        .ok()
        .and_then(|r| r.peel_to_commit().ok())
        .and_then(|c| c.tree().ok())
        .map(|t| t.id());

    let refname = format!("refs/heads/{name}");
    let obj = repo
        .revparse_single(&refname)
        .map_err(|e| format!("branch not found: {e}"))?;
    let target_tree_oid = obj
        .peel_to_commit()
        .and_then(|c| c.tree())
        .map(|t| t.id())
        .map_err(|e| format!("peel target tree: {e}"))?;

    let mut co = CheckoutBuilder::new();
    repo.checkout_tree(&obj, Some(&mut co))
        .map_err(|e| format!("checkout failed: {e}"))?;
    if let Err(set_head_err) = repo.set_head(&refname) {
        // checkout_tree succeeded → workdir+index are at the target tree, but
        // HEAD was never moved. Roll back the workdir+index to the original
        // HEAD's tree so the user is left exactly where they started instead
        // of with an index that doesn't match HEAD.
        let rollback_status = match original_head_tree_oid
            .and_then(|oid| repo.find_tree(oid).ok())
        {
            Some(tree) => {
                let mut rollback_co = CheckoutBuilder::new();
                rollback_co.force();
                match repo.checkout_tree(tree.as_object(), Some(&mut rollback_co)) {
                    Ok(()) => "rolled_back".to_string(),
                    Err(e) => format!("ROLLBACK_FAILED: {e}"),
                }
            }
            None => "ROLLBACK_SKIPPED_NO_ORIGINAL_TREE".to_string(),
        };

        perf_event(
            &app,
            "checkout_branch:set_head_failed",
            json!({
                "branch": &name,
                "setHeadError": set_head_err.message(),
                "rollback": &rollback_status,
            }),
        );

        // Translate libgit2's cryptic "current HEAD of a linked repository"
        // error into something the user can act on.
        let raw_msg = set_head_err.message();
        let user_msg = if raw_msg.contains("current HEAD of a linked repository") {
            format!(
                "'{name}' is already checked out in another worktree; close it there before switching"
            )
        } else {
            format!("set_head failed: {set_head_err}")
        };
        return Err(user_msg);
    }

    // Verify the post-condition: `.git/index`'s tree OID equals the branch
    // tip's tree OID. Anything else means libgit2's SAFE checkout merged or
    // skipped files in a way that left the index out of sync with HEAD — the
    // exact symptom of the user-reported branch-diff index-corruption bug.
    // Re-derive `index_tree` from a fresh re-read so we measure on-disk truth,
    // not the cached in-memory copy that libgit2 just wrote from.
    if let Ok(mut idx) = repo.index() {
        let _ = idx.read(true);
        match idx.write_tree() {
            Ok(written) if written != target_tree_oid => {
                perf_event(
                    &app,
                    "checkout_branch:index_mismatch",
                    json!({
                        "branch": &name,
                        "expectedTreeOid": target_tree_oid.to_string(),
                        "actualTreeOid": written.to_string(),
                    }),
                );
            }
            Ok(_) => {}
            Err(e) => {
                perf_event(
                    &app,
                    "checkout_branch:write_tree_failed",
                    json!({ "branch": &name, "error": e.to_string() }),
                );
            }
        }
    }

    // Branch switches do not always trigger fs events the watcher notices in
    // time, so kick a refresh explicitly.
    let _ = app.emit_to(window.label(), "repo:changed", json!({}));
    Ok(())
}

#[cfg(test)]
fn push_patch_line(patch: &mut String, origin: char, content: &[u8]) {
    match origin {
        ' ' | '+' | '-' => patch.push(origin),
        '=' | '>' | '<' => {
            patch.push_str("\\ No newline at end of file\n");
            return;
        }
        _ => {}
    }
    patch.push_str(&String::from_utf8_lossy(content));
}

#[cfg(test)]
mod tests {
    use super::push_patch_line;

    #[test]
    fn patch_lines_keep_diff_origins() {
        let mut patch = String::new();
        push_patch_line(&mut patch, 'H', b"@@ -1,2 +1,2 @@\n");
        push_patch_line(&mut patch, ' ', b"same\n");
        push_patch_line(&mut patch, '-', b"old\n");
        push_patch_line(&mut patch, '+', b"new\n");

        assert_eq!(patch, "@@ -1,2 +1,2 @@\n same\n-old\n+new\n");
    }

    #[test]
    fn window_state_is_isolated_per_label() {
        use std::sync::Arc;
        let state = super::AppState::default();
        let a = state.window("main");
        let b = state.window("w-1");
        assert!(!Arc::ptr_eq(&a, &b), "different labels must get different state");
        assert!(Arc::ptr_eq(&a, &state.window("main")), "same label returns same state");
        state.remove_window("main");
        assert!(
            !Arc::ptr_eq(&a, &state.window("main")),
            "a removed label yields fresh state on next access"
        );
        assert!(
            Arc::ptr_eq(&b, &state.window("w-1")),
            "removing one label does not disturb another"
        );
    }
}
