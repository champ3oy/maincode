# Maincode Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the cloned cub.dev repo in place into **Maincode**, a simple desktop code editor with a file tree, CodeMirror 6 editing, tabs, file operations, find & replace, a command palette, a VS Code-style source-control panel, and an integrated terminal.

**Architecture:** Tauri v2 desktop app. React 19 + Vite + Tailwind v4 frontend talks to a Rust backend via `invoke()` (request/response) and Tauri events (streaming). Three Rust command groups: `fs.rs` (new — file ops), `git.rs` (kept from cub, trimmed to working-changes surface), `pty.rs` (new — terminal). Frontend state is React context + hooks, matching cub's existing style.

**Tech Stack:** Tauri 2, React 19, TypeScript (strict), Vite 7, Tailwind 4, CodeMirror 6, @xterm/xterm, portable-pty, git2, Bun (JS package manager & scripts), Vitest (frontend unit tests), cargo test (Rust).

**Spec:** `docs/superpowers/specs/2026-07-12-maincode-editor-design.md`

## Global Constraints

- Platform: macOS Apple Silicon (arm64). Repo root: the cloned `cub.dev/` directory; work on the existing `maincode` git branch.
- Every commit must pass: `bun run typecheck` AND `(cd src-tauri && cargo check)`. Tasks that touch tests also run `bun run test` / `(cd src-tauri && cargo test)`.
- App name **Maincode**; Tauri identifier `com.morpheusdesk.maincode`; Cargo package `maincode`, lib `maincode_lib`; version resets to `0.1.0`.
- JS packages managed with **bun** (`bun add`, `bun install` — never npm/pnpm; the lockfile is `bun.lock`).
- State management: React context + hooks only. No Redux/Zustand/etc.
- localStorage keys are prefixed `maincode:`.
- New UI builds on the existing `src/components/ui/*` kit (shadcn/base-ui), `@tabler/icons-react` icons, and `cn()` from `@/lib/utils`.
- The editor/terminal monospace font-family is `"App Mono"` (already declared via `@font-face` in `src/App.css`), fallback `ui-monospace, monospace`.
- Commit messages: conventional style (`feat:`, `refactor:`, `chore:`, `docs:`) matching cub's history.
- TS is strict with `noUnusedLocals`/`noUnusedParameters` — remove imports/vars you orphan.
- `git rm`/`rm` of listed files is authoritative: if a listed file has other importers, the typecheck gate will surface them; fix by removing the orphaned usage, not by keeping the file.

---

### Task 1: Install toolchain and verify baseline

**Files:** none (environment only)

**Interfaces:**
- Consumes: fresh clone at repo root, Node 22 / Xcode CLT already present.
- Produces: working `bun`, `cargo`, deps installed; baseline `typecheck` + `cargo check` green.

- [ ] **Step 1: Install Rust**

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"
rustc --version   # expect: rustc 1.8x
```

- [ ] **Step 2: Install Bun**

```bash
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"
bun --version     # expect: 1.x
```

- [ ] **Step 3: Install JS deps**

```bash
bun install
```
Expected: completes without errors (lockfile `bun.lock` already present).

- [ ] **Step 4: Baseline frontend typecheck**

```bash
bun run typecheck
```
Expected: exits 0, no output.

- [ ] **Step 5: Baseline Rust check** (slow first run — vendored libgit2/openssl compile, ~5–10 min)

```bash
cd src-tauri && cargo check && cargo test && cd ..
```
Expected: `cargo check` exits 0; `cargo test` runs cub's existing tests, all pass.

No commit (no repo changes).

---

### Task 2: Strip backend — remove MCP/review bridge, history, branch-diff, clone

**Files:**
- Delete: `sidecar/cub-mcp.js`, `.mcp.json`, `src-tauri/src/review_bridge.rs`
- Modify: `src-tauri/src/lib.rs` (full replacement below), `src-tauri/src/main.rs` (full replacement below), `src-tauri/src/git.rs`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `package.json`

**Interfaces:**
- Consumes: current cub backend.
- Produces: backend exposing exactly these commands (unchanged signatures, all defined in `git.rs` today): `open_repo`, `get_repo_status`, `get_file_contents_batch`, `stage_file`, `unstage_file`, `stage_all`, `unstage_all`, `commit`, `get_repo_branch`, `discard_file`, `list_branches`, `checkout_branch`, plus `get_launch_path` in `lib.rs`. `AppState` shrinks to `{ repo, watcher, watcher_generation }`.

- [ ] **Step 1: Delete review/MCP files**

```bash
git rm -r sidecar .mcp.json src-tauri/src/review_bridge.rs
```

- [ ] **Step 2: Replace `src-tauri/src/lib.rs` with:**

```rust
mod git;
mod watcher;

use git::AppState;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::{Mutex, OnceLock};
use tauri::Manager;

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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            repo: Mutex::new(None),
            watcher: Mutex::new(None),
            watcher_generation: AtomicU64::new(0),
        })
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
```

- [ ] **Step 3: Replace `src-tauri/src/main.rs` with:**

```rust
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
```
(`cub_lib` is renamed in Task 4.)

- [ ] **Step 4: Trim `src-tauri/src/git.rs`**

In `AppState` (near line 33) keep only:
```rust
pub struct AppState {
    pub repo: Mutex<Option<Repository>>,
    pub watcher: Mutex<Option<crate::watcher::RepoWatcher>>,
    pub watcher_generation: AtomicU64,
}
```
Delete these `#[tauri::command]` functions and everything used only by them (helper fns, structs, `use` items — let `cargo check` warnings/errors drive the sweep): `get_branch_diff`, `get_branch_file_contents_batch`, `clone_repo`, `cancel_clone`, `cleanup_path`, `init_repo`, `get_head_state`, `get_commit_details_batch`, `get_commit_diff`, `get_commit_patch`, `get_root_commit_file_contents_batch`, `list_commits_stream`. Also delete `resolve_base_ref` (only used by branch diff) and any `#[cfg(test)]` tests that call deleted functions (keep tests of kept functions). Fix `open_repo`/other kept fns if they referenced deleted `AppState` fields (`walker_*`, `clone_cancels` — e.g. `open_repo` may cancel a walker; delete those lines).

- [ ] **Step 5: Remove `ureq` from `src-tauri/Cargo.toml`** (only `review_bridge.rs` used it) — delete the line `ureq = { version = "3", features = ["json"] }`.

- [ ] **Step 6: Remove sidecar from Tauri bundle** — in `src-tauri/tauri.conf.json` delete the line `"resources": ["../sidecar/cub-mcp.bundled.js"],`.

- [ ] **Step 7: Remove MCP from `package.json`** — delete the `mcp:bundle`, `mcp:server`, `mcp:mcp` scripts; change `"build": "vite build && bun run mcp:bundle"` to `"build": "vite build"`; delete devDependencies `@modelcontextprotocol/sdk` and `better-sqlite3`. Then `bun install` to update the lockfile.

- [ ] **Step 8: Verify**

```bash
cd src-tauri && cargo check && cargo test && cd ..
```
Expected: both exit 0 (warnings about now-unused imports must also be fixed — the sweep is done when check is clean).

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor: strip MCP review bridge, history, branch diff, and clone from backend"
```

---

### Task 3: Strip frontend to a running shell

**Files:**
- Delete: `src/components/comments/` (2 files), `src/components/commit-detail/`, `src/components/onboarding/` (3 files), `src/components/sidebar/sidebar.tsx`, `src/components/sidebar/sidebar-tabs.tsx`, `src/components/sidebar/sidebar-history.tsx`, `src/components/sidebar/commit-row.tsx`, `src/components/sidebar/commit-avatar.tsx`, `src/components/sidebar/sidebar-context-menu.tsx`, `src/hooks/use-comments.ts`, `src/hooks/use-branch-diff.ts`, `src/hooks/use-commit-diff.ts`, `src/hooks/use-commit-history.ts`, `src/hooks/use-commit-details-cache.tsx`, `src/hooks/use-recent-branches.ts`, `src/types/comments.ts`, `src/components/diff-panel/annotation-target.ts`
- Keep (reused later): `src/components/sidebar/commit-bar.tsx`, `src/components/diff-panel/diff-panel.tsx`, `src/components/diff-panel/diff-toolbar.tsx`, `src/components/status-bar/status-bar.tsx`, `src/hooks/use-repo-status.ts`, `src/hooks/use-diffs.ts`, `src/hooks/use-diff-settings.tsx`, `src/hooks/use-recent-repos.tsx`
- Modify: `src/App.tsx` (full replacement below), `src/main.tsx`, `src/lib/tauri.ts`, `src/components/diff-panel/diff-panel.tsx`, `src/components/diff-panel/diff-toolbar.tsx`

**Interfaces:**
- Consumes: Task 2's backend command set.
- Produces: an app that opens a git repo, shows a placeholder main area + `StatusBar`, and typechecks. `DiffPanel` props reduced to: `files`, `diffs`, `loading`, `diffStyle`, `onDiffStyleChange`, `allExpanded`, `onToggleExpandAll`, `scrollToPath`, `scrollNonce` (plus any mode-agnostic internals that survive; **no** annotation/comment/branch/commit-detail props).

- [ ] **Step 1: Delete the files listed above** (`git rm -r` the directories, `git rm` the files).

- [ ] **Step 2: Trim `src/lib/tauri.ts`** — delete the functions, types, and constants for removed commands: `submitReview`, `SubmitReviewResponse`, `CommentIdMapping`, `cloneRepo`, `CloneProgress`, `cancelClone`, `cleanupPath`, `initRepo`, `getBranchDiff`, `BranchDiff`, `getBranchFileContentsBatch`, `getHeadState`, `HeadState`, `getCommitDetailsBatch`, `CommitDetails`, `getCommitDiff`, `CommitDiff`, `getCommitPatch`, `CommitPatch`, `CommitGraphRow`, `ListCommitsStreamAck`, `CommitHistoryChunkPayload`, `CommitHistoryDonePayload`, `CommitHistoryErrorPayload`, `COMMIT_HISTORY_*` constants, `listCommitsStream`, `getRootCommitFileContentsBatch`, and the `import type { ReviewComment }` line. Keep everything else (`openRepo`, `getRepoStatus`, `FileEntry`, `ChangeKind`, `RepoStatus`, `FileContents*`, `stage*`/`unstage*`, `commit`, `CommitOptions`, `discardFile`, `getLaunchPath`, `getRepoBranch`, `BranchInfo`, `listBranches`, `checkoutBranch`).

- [ ] **Step 3: Strip annotations from `src/components/diff-panel/diff-panel.tsx`**

Remove (typecheck drives completeness):
- Imports: `CommentForm`, `CommentBubble`, `getAnnotationTarget`, `ActionType`/`CommentMetadata` (from `@/types/comments`), and from `@pierre/diffs`: `AnnotationSide`, `DiffLineAnnotation`, `SelectedLineRange` (drop each only if now unused).
- `type Item = CodeViewItem<CommentMetadata>` → `type Item = CodeViewItem`.
- Props from `DiffPanelProps` + destructuring + all usages: `annotationsByFile`, `hasOpenForm`, `totalCommentCount`, `pendingCount`, `acknowledgedCount`, `resolvedCount`, `onAddAnnotation`, `onCancelAnnotation`, `onSubmitAnnotation`, `onDeleteAnnotation`, `onSubmitReview`, `onClearResolved`, `submittingReview`, and the history-mode extras `readOnly`, `branchInfo`, `workingChangesNotice`, `commitDetailHeader`, `commitDetailMessage`, `commitStats`.
- All JSX/render callbacks that rendered `CommentForm`/`CommentBubble`, annotation gutters, line-selection→annotation handlers, and the branch-info/commit-detail header blocks.
- In `src/components/diff-panel/diff-toolbar.tsx`, remove any comment-count / submit-review props and UI the above deletions orphan.

- [ ] **Step 4: Trim `src/main.tsx`** — remove the `CommitDetailsCacheProvider` import and its JSX wrapper (keep `WorkerPoolContextProvider`, `ThemeProvider`, `DiffSettingsProvider`, `RecentReposProvider`).

- [ ] **Step 5: Replace `src/App.tsx` with:**

```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";
import { StatusBar } from "@/components/status-bar/status-bar";
import {
  clearLastOpenedRepo,
  readLastOpenedRepo,
  useRepoStatus,
} from "@/hooks/use-repo-status";
import { useRecentRepos } from "@/hooks/use-recent-repos";
import { getLaunchPath, getRepoBranch } from "@/lib/tauri";

function App() {
  const { workdir, status, error, refresh, open } = useRepoStatus();
  const { addRecent } = useRecentRepos();
  const [branch, setBranch] = useState<string | null>(null);
  const restoreOpenStartedRef = useRef(false);

  const openAndRecord = useCallback(
    async (path: string) => {
      const dir = await open(path);
      addRecent(dir);
      return dir;
    },
    [open, addRecent],
  );
  const openRef = useRef(openAndRecord);
  openRef.current = openAndRecord;

  // Honor a CLI launch path first; otherwise restore the last opened repo.
  useEffect(() => {
    let cancelled = false;
    getLaunchPath()
      .then((launchPath) => {
        if (cancelled) return;
        const restorePath = launchPath ?? readLastOpenedRepo();
        if (!restorePath || restoreOpenStartedRef.current) return;
        restoreOpenStartedRef.current = true;
        openRef.current(restorePath).catch((e) => {
          if (!launchPath) clearLastOpenedRepo();
          toast.error(`Failed to open: ${e}`);
        });
      })
      .catch((e) => console.error("[maincode] getLaunchPath failed:", e));
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-refresh git status when the watcher reports disk changes.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    if (!workdir) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    listen("repo:changed", () => refreshRef.current()).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [workdir]);

  // Track the current branch; status changes fire after commit/checkout.
  useEffect(() => {
    if (!workdir) {
      setBranch(null);
      return;
    }
    let cancelled = false;
    getRepoBranch(workdir)
      .then((b) => {
        if (!cancelled) setBranch(b);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [workdir, status]);

  const handleOpenClick = useCallback(async () => {
    const selected = await openDialog({ directory: true, multiple: false });
    if (typeof selected === "string") {
      openRef.current(selected).catch((e) => toast.error(`Failed to open: ${e}`));
    }
  }, []);

  const handleBranchSwitched = useCallback(async () => {
    await refresh();
    if (!workdir) return;
    try {
      setBranch(await getRepoBranch(workdir));
    } catch {
      // ignore
    }
  }, [refresh, workdir]);

  return (
    <>
      <div className="flex h-full flex-col">
        <main className="flex min-h-0 flex-1 items-center justify-center border-t border-border bg-background">
          {error ? (
            <p className="text-destructive text-sm">{error}</p>
          ) : workdir ? (
            <p className="text-muted-foreground text-sm">Editor coming soon</p>
          ) : (
            <Button onClick={handleOpenClick}>Open Folder</Button>
          )}
        </main>
        {workdir && (
          <StatusBar
            workdir={workdir}
            branch={branch}
            onOpenRepo={openAndRecord}
            onBranchSwitched={handleBranchSwitched}
          />
        )}
      </div>
      <Toaster />
    </>
  );
}

export default App;
```
If `StatusBar`'s prop names differ slightly (check `StatusBarProps` in `src/components/status-bar/status-bar.tsx`), adapt the call site — do not change the StatusBar component in this task. If `status-bar.tsx` or `use-repo-status.ts` import anything deleted above, remove those code paths the same way (typecheck-driven).

- [ ] **Step 6: Verify**

```bash
bun run typecheck
```
Expected: exits 0. Then manual smoke test:
```bash
bun run tauri:dev
```
Expected: window opens; "Open Folder" button; picking a git repo shows "Editor coming soon" + status bar with branch name; picking a non-repo shows an error toast (fine for now). Quit with Cmd+Q (must not hang — the exit handler no longer joins the removed bridge threads).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: strip frontend to minimal shell (no review, history, or onboarding)"
```

---

### Task 4: Rename Cub → Maincode, drop cub distribution

**Files:**
- Modify: `package.json`, `src-tauri/Cargo.toml`, `src-tauri/src/main.rs`, `src-tauri/tauri.conf.json`, `src-tauri/tauri.dev.conf.json`, `src-tauri/capabilities/default.json`, `src-tauri/src/lib.rs`, `index.html`, `README.md`
- Delete: `Casks/`, `.github/`, `scripts/`, `CONTEXT.md`

**Interfaces:**
- Produces: app identity `Maincode` / `com.morpheusdesk.maincode` / crate `maincode` (lib `maincode_lib`); no auto-updater.

- [ ] **Step 1: `package.json`** — `"name": "maincode"`, `"version": "0.1.0"`; remove dependencies `@tauri-apps/plugin-updater` and `@tauri-apps/plugin-process`; run `bun install`.
- [ ] **Step 2: `src-tauri/Cargo.toml`** — `name = "maincode"`, `version = "0.1.0"`, `description = "A simple desktop code editor"`; `[lib] name = "maincode_lib"`; remove `tauri-plugin-updater` and `tauri-plugin-process` dependency lines.
- [ ] **Step 3: `src-tauri/src/lib.rs`** — remove the two plugin lines `.plugin(tauri_plugin_updater::Builder::new().build())` and `.plugin(tauri_plugin_process::init())`.
- [ ] **Step 4: `src-tauri/src/main.rs`** — `cub_lib::` → `maincode_lib::` (2 sites), `[cub]` → `[maincode]`.
- [ ] **Step 5: `src-tauri/tauri.conf.json`** — `productName: "Maincode"`, `version: "0.1.0"`, `identifier: "com.morpheusdesk.maincode"`, window `title: "Maincode"`; delete the whole `"plugins"` block (updater config). `tauri.dev.conf.json` — `productName: "Maincode (dev)"`, title `"Maincode (dev)"`.
- [ ] **Step 6: `src-tauri/capabilities/default.json`** — remove `"updater:default"` and `"process:default"` from permissions.
- [ ] **Step 7: Delete cub distribution files:** `git rm -r Casks .github scripts CONTEXT.md`
- [ ] **Step 8: `index.html`** — `<title>Maincode</title>`.
- [ ] **Step 9: Sweep remaining "cub" strings** in kept source: `grep -rn "cub" src src-tauri/src --include="*.ts" --include="*.tsx" --include="*.rs" -i` — rename log prefixes (`[cub-perf]` → `[maincode-perf]`, `[cub]` → `[maincode]`) and any comments. `README.md`: replace content with a placeholder heading `# Maincode` + one line "A simple desktop code editor. Docs TBD in final task." (rewritten properly in Task 18).
- [ ] **Step 10: Verify**

```bash
bun run typecheck && (cd src-tauri && cargo check) && bun run tauri:dev
```
Expected: window titled **"Maincode (dev)"** opens and behaves as in Task 3.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "chore: rename Cub to Maincode, drop updater and cub distribution"
```

---

### Task 5: fs.rs — read commands (TDD)

**Files:**
- Create: `src-tauri/src/fs_ops.rs` (named `fs_ops` to avoid clashing with `std::fs`)
- Modify: `src-tauri/src/lib.rs`, `src-tauri/Cargo.toml`

**Interfaces:**
- Produces (Rust commands → JS): `read_dir(path: String) -> Vec<DirEntryInfo{name, path, is_dir}>` (sorted dirs-first then case-insensitive alpha; `.git` skipped); `read_file(path: String) -> ReadFileResult{content: Option<String>, reason: Option<"binary"|"too_large">}` (2 MB cap).

- [ ] **Step 1: Add dev-dependency** — in `src-tauri/Cargo.toml`:

```toml
[dev-dependencies]
tempfile = "3"
```

- [ ] **Step 2: Create `src-tauri/src/fs_ops.rs` with failing tests first:**

```rust
use serde::Serialize;
use std::fs;
use std::path::Path;

const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Serialize, Debug, PartialEq)]
pub struct DirEntryInfo {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct ReadFileResult {
    pub content: Option<String>,
    pub reason: Option<String>, // "binary" | "too_large"
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn read_dir_sorts_dirs_first_and_skips_git() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir(tmp.path().join(".git")).unwrap();
        fs::create_dir(tmp.path().join("src")).unwrap();
        fs::write(tmp.path().join("a.txt"), "a").unwrap();
        fs::write(tmp.path().join("B.txt"), "b").unwrap();
        let entries = read_dir_inner(tmp.path()).unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["src", "a.txt", "B.txt"]);
        assert!(entries[0].is_dir);
    }

    #[test]
    fn read_file_returns_text_content() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("f.txt");
        fs::write(&p, "hello").unwrap();
        let r = read_file_inner(&p).unwrap();
        assert_eq!(r.content.as_deref(), Some("hello"));
        assert_eq!(r.reason, None);
    }

    #[test]
    fn read_file_flags_binary() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("f.bin");
        fs::write(&p, [0u8, 159, 146, 150]).unwrap();
        let r = read_file_inner(&p).unwrap();
        assert_eq!(r.content, None);
        assert_eq!(r.reason.as_deref(), Some("binary"));
    }

    #[test]
    fn read_file_flags_too_large() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("big.txt");
        fs::write(&p, vec![b'x'; (MAX_FILE_BYTES + 1) as usize]).unwrap();
        let r = read_file_inner(&p).unwrap();
        assert_eq!(r.content, None);
        assert_eq!(r.reason.as_deref(), Some("too_large"));
    }
}
```

- [ ] **Step 3: Register module and run tests to verify they fail** — add `mod fs_ops;` to `src-tauri/src/lib.rs`, then:

```bash
cd src-tauri && cargo test fs_ops
```
Expected: FAIL — `read_dir_inner`/`read_file_inner` not found.

- [ ] **Step 4: Implement (add above the `#[cfg(test)]` block):**

```rust
pub fn read_dir_inner(path: &Path) -> Result<Vec<DirEntryInfo>, String> {
    let mut entries: Vec<DirEntryInfo> = fs::read_dir(path)
        .map_err(|e| e.to_string())?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let name = entry.file_name().to_string_lossy().to_string();
            if name == ".git" {
                return None;
            }
            let is_dir = entry.file_type().ok()?.is_dir();
            Some(DirEntryInfo {
                path: entry.path().to_string_lossy().to_string(),
                name,
                is_dir,
            })
        })
        .collect();
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

pub fn read_file_inner(path: &Path) -> Result<ReadFileResult, String> {
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_FILE_BYTES {
        return Ok(ReadFileResult { content: None, reason: Some("too_large".into()) });
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    if bytes.contains(&0) {
        return Ok(ReadFileResult { content: None, reason: Some("binary".into()) });
    }
    match String::from_utf8(bytes) {
        Ok(content) => Ok(ReadFileResult { content: Some(content), reason: None }),
        Err(_) => Ok(ReadFileResult { content: None, reason: Some("binary".into()) }),
    }
}

#[tauri::command]
pub fn read_dir(path: String) -> Result<Vec<DirEntryInfo>, String> {
    read_dir_inner(Path::new(&path))
}

#[tauri::command]
pub fn read_file(path: String) -> Result<ReadFileResult, String> {
    read_file_inner(Path::new(&path))
}
```

- [ ] **Step 5: Register commands** — in `lib.rs` `generate_handler!`, add after the git commands:

```rust
            fs_ops::read_dir,
            fs_ops::read_file,
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd src-tauri && cargo test fs_ops
```
Expected: 4 passed.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: add fs read_dir and read_file backend commands"
```

---

### Task 6: fs.rs — write commands (TDD)

**Files:**
- Modify: `src-tauri/src/fs_ops.rs`, `src-tauri/src/lib.rs`

**Interfaces:**
- Produces: `write_file(path, contents)`, `create_file(path)` (errors if exists; creates parent dirs), `create_dir(path)` (errors if exists), `rename_path(from, to)` (errors if `to` exists), `delete_path(path)` (file or recursive dir). All `Result<(), String>`.

- [ ] **Step 1: Add failing tests to the `tests` module in `fs_ops.rs`:**

```rust
    #[test]
    fn write_then_read_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("f.txt");
        write_file_inner(&p, "abc").unwrap();
        assert_eq!(read_file_inner(&p).unwrap().content.as_deref(), Some("abc"));
    }

    #[test]
    fn create_file_fails_if_exists_and_makes_parents() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("nested/dir/new.txt");
        create_file_inner(&p).unwrap();
        assert!(p.exists());
        assert!(create_file_inner(&p).is_err());
    }

    #[test]
    fn create_dir_fails_if_exists() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("d");
        create_dir_inner(&p).unwrap();
        assert!(p.is_dir());
        assert!(create_dir_inner(&p).is_err());
    }

    #[test]
    fn rename_refuses_to_overwrite() {
        let tmp = tempfile::tempdir().unwrap();
        let a = tmp.path().join("a.txt");
        let b = tmp.path().join("b.txt");
        fs::write(&a, "a").unwrap();
        fs::write(&b, "b").unwrap();
        assert!(rename_path_inner(&a, &b).is_err());
        let c = tmp.path().join("c.txt");
        rename_path_inner(&a, &c).unwrap();
        assert!(c.exists() && !a.exists());
    }

    #[test]
    fn delete_removes_files_and_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        let f = tmp.path().join("f.txt");
        fs::write(&f, "x").unwrap();
        delete_path_inner(&f).unwrap();
        assert!(!f.exists());
        let d = tmp.path().join("d");
        fs::create_dir(&d).unwrap();
        fs::write(d.join("inner.txt"), "y").unwrap();
        delete_path_inner(&d).unwrap();
        assert!(!d.exists());
    }
```

- [ ] **Step 2: Run to verify failure** — `cd src-tauri && cargo test fs_ops` → FAIL (`*_inner` not found).

- [ ] **Step 3: Implement:**

```rust
pub fn write_file_inner(path: &Path, contents: &str) -> Result<(), String> {
    fs::write(path, contents).map_err(|e| e.to_string())
}

pub fn create_file_inner(path: &Path) -> Result<(), String> {
    if path.exists() {
        return Err(format!("{} already exists", path.display()));
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(path, "").map_err(|e| e.to_string())
}

pub fn create_dir_inner(path: &Path) -> Result<(), String> {
    if path.exists() {
        return Err(format!("{} already exists", path.display()));
    }
    fs::create_dir_all(path).map_err(|e| e.to_string())
}

pub fn rename_path_inner(from: &Path, to: &Path) -> Result<(), String> {
    if to.exists() {
        return Err(format!("{} already exists", to.display()));
    }
    fs::rename(from, to).map_err(|e| e.to_string())
}

pub fn delete_path_inner(path: &Path) -> Result<(), String> {
    let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if meta.is_dir() {
        fs::remove_dir_all(path).map_err(|e| e.to_string())
    } else {
        fs::remove_file(path).map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn write_file(path: String, contents: String) -> Result<(), String> {
    write_file_inner(Path::new(&path), &contents)
}

#[tauri::command]
pub fn create_file(path: String) -> Result<(), String> {
    create_file_inner(Path::new(&path))
}

#[tauri::command]
pub fn create_dir(path: String) -> Result<(), String> {
    create_dir_inner(Path::new(&path))
}

#[tauri::command]
pub fn rename_path(from: String, to: String) -> Result<(), String> {
    rename_path_inner(Path::new(&from), Path::new(&to))
}

#[tauri::command]
pub fn delete_path(path: String) -> Result<(), String> {
    delete_path_inner(Path::new(&path))
}
```

- [ ] **Step 4: Register** — add to `generate_handler!`: `fs_ops::write_file, fs_ops::create_file, fs_ops::create_dir, fs_ops::rename_path, fs_ops::delete_path,`

- [ ] **Step 5: Run tests** — `cargo test fs_ops` → 9 passed.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat: add fs write/create/rename/delete backend commands"`

---

### Task 7: Vitest setup, TS fs wrappers, language detection (TDD)

**Files:**
- Create: `vitest.config.ts`, `src/lib/fs.ts`, `src/lib/language.ts`, `src/lib/language.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces:
  - `src/lib/fs.ts`: `readDir(path): Promise<DirEntryInfo[]>`, `readFile(path): Promise<ReadFileResult>`, `writeFile(path, contents): Promise<void>`, `createFile(path)`, `createDir(path)`, `renamePath(from, to)`, `deletePath(path)`; types `DirEntryInfo { name: string; path: string; is_dir: boolean }`, `ReadFileResult { content: string | null; reason: "binary" | "too_large" | null }`.
  - `src/lib/language.ts`: `type LanguageKey`, `languageKeyForPath(path: string): LanguageKey | null`, `LANGUAGE_LABELS: Record<LanguageKey, string>`.
  - `bun run test` runs Vitest.

- [ ] **Step 1: Install and configure Vitest**

```bash
bun add -d vitest
```
Create `vitest.config.ts`:
```ts
import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
```
Add to `package.json` scripts: `"test": "vitest run"`.

- [ ] **Step 2: Write failing test `src/lib/language.test.ts`:**

```ts
import { describe, expect, it } from "vitest";
import { languageKeyForPath } from "./language";

describe("languageKeyForPath", () => {
  it("maps common extensions", () => {
    expect(languageKeyForPath("a.ts")).toBe("typescript");
    expect(languageKeyForPath("a.tsx")).toBe("tsx");
    expect(languageKeyForPath("a.js")).toBe("javascript");
    expect(languageKeyForPath("a.jsx")).toBe("jsx");
    expect(languageKeyForPath("a.py")).toBe("python");
    expect(languageKeyForPath("a.html")).toBe("html");
    expect(languageKeyForPath("a.css")).toBe("css");
    expect(languageKeyForPath("a.json")).toBe("json");
    expect(languageKeyForPath("a.md")).toBe("markdown");
    expect(languageKeyForPath("a.rs")).toBe("rust");
    expect(languageKeyForPath("a.yml")).toBe("yaml");
  });

  it("is case-insensitive and uses the last extension", () => {
    expect(languageKeyForPath("A.TSX")).toBe("tsx");
    expect(languageKeyForPath("archive.tar.json")).toBe("json");
  });

  it("uses only the basename", () => {
    expect(languageKeyForPath("src/deep/dir/mod.rs")).toBe("rust");
  });

  it("returns null for unknown, extension-less, and dotfiles", () => {
    expect(languageKeyForPath("Makefile")).toBeNull();
    expect(languageKeyForPath("file.xyz")).toBeNull();
    expect(languageKeyForPath(".gitignore")).toBeNull();
  });
});
```

- [ ] **Step 3: Run to verify failure** — `bun run test` → FAIL (cannot resolve `./language`).

- [ ] **Step 4: Implement `src/lib/language.ts`:**

```ts
export type LanguageKey =
  | "javascript"
  | "jsx"
  | "typescript"
  | "tsx"
  | "python"
  | "html"
  | "css"
  | "json"
  | "markdown"
  | "rust"
  | "yaml";

const EXT_TO_KEY: Record<string, LanguageKey> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  py: "python",
  html: "html",
  htm: "html",
  css: "css",
  json: "json",
  md: "markdown",
  markdown: "markdown",
  rs: "rust",
  yml: "yaml",
  yaml: "yaml",
};

export const LANGUAGE_LABELS: Record<LanguageKey, string> = {
  javascript: "JavaScript",
  jsx: "JSX",
  typescript: "TypeScript",
  tsx: "TSX",
  python: "Python",
  html: "HTML",
  css: "CSS",
  json: "JSON",
  markdown: "Markdown",
  rust: "Rust",
  yaml: "YAML",
};

export function languageKeyForPath(path: string): LanguageKey | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return EXT_TO_KEY[ext] ?? null;
}
```

- [ ] **Step 5: Run tests** — `bun run test` → 4 passed.

- [ ] **Step 6: Create `src/lib/fs.ts`:**

```ts
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
```

- [ ] **Step 7: Verify + commit**

```bash
bun run typecheck && bun run test
git add -A && git commit -m "feat: add vitest, fs invoke wrappers, and language detection"
```

---

### Task 8: Workspace context, welcome screen, App v2

**Files:**
- Create: `src/hooks/use-workspace.tsx`, `src/components/welcome/welcome.tsx`
- Modify: `src/main.tsx`, `src/App.tsx` (full replacement below)

**Interfaces:**
- Consumes: `useRecentRepos` (`{ recent: RecentRepo[]; addRecent(path); removeRecent(path) }` — recents are plain paths, reused for folders), `useRepoStatus().open/close/status/refresh`, `getLaunchPath`.
- Produces: `useWorkspace(): { rootPath: string | null; rootName: string | null; openFolder(path): void; closeFolder(): void }`; `basename(path: string): string` exported from `use-workspace.tsx`; App concept `gitAvailable: boolean` (folder opened but not a git repo → git UI disabled, editor still works).

- [ ] **Step 1: Create `src/hooks/use-workspace.tsx`:**

```tsx
import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";

const LAST_FOLDER_KEY = "maincode:last-folder";

export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i === -1 ? trimmed : trimmed.slice(i + 1);
}

export function readLastFolder(): string | null {
  try {
    return window.localStorage.getItem(LAST_FOLDER_KEY);
  } catch {
    return null;
  }
}

interface WorkspaceContextValue {
  rootPath: string | null;
  rootName: string | null;
  openFolder: (path: string) => void;
  closeFolder: () => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [rootPath, setRootPath] = useState<string | null>(null);

  const openFolder = useCallback((path: string) => {
    setRootPath(path);
    try {
      window.localStorage.setItem(LAST_FOLDER_KEY, path);
    } catch {
      // ignore
    }
  }, []);

  const closeFolder = useCallback(() => {
    setRootPath(null);
    try {
      window.localStorage.removeItem(LAST_FOLDER_KEY);
    } catch {
      // ignore
    }
  }, []);

  return (
    <WorkspaceContext.Provider
      value={{
        rootPath,
        rootName: rootPath ? basename(rootPath) : null,
        openFolder,
        closeFolder,
      }}
    >
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace must be used within WorkspaceProvider");
  return ctx;
}
```

- [ ] **Step 2: Create `src/components/welcome/welcome.tsx`:**

```tsx
import { IconFolderOpen, IconX } from "@tabler/icons-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { useRecentRepos } from "@/hooks/use-recent-repos";
import { basename } from "@/hooks/use-workspace";

interface WelcomeProps {
  onOpenFolder: (path: string) => void;
}

export function Welcome({ onOpenFolder }: WelcomeProps) {
  const { recent, removeRecent } = useRecentRepos();

  const handleBrowse = async () => {
    const selected = await openDialog({ directory: true, multiple: false });
    if (typeof selected === "string") onOpenFolder(selected);
  };

  return (
    <main className="flex h-dvh flex-col items-center justify-center gap-6 bg-background">
      <div className="text-center">
        <h1 className="text-2xl font-semibold">Maincode</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          A simple code editor
        </p>
      </div>
      <Button onClick={handleBrowse}>
        <IconFolderOpen className="size-4" />
        Open Folder
      </Button>
      {recent.length > 0 && (
        <div className="w-72">
          <p className="text-muted-foreground mb-2 text-xs font-medium uppercase tracking-wide">
            Recent
          </p>
          <ul className="flex flex-col gap-1">
            {recent.map((r) => (
              <li
                key={r.path}
                className="group flex items-center justify-between gap-2"
              >
                <button
                  type="button"
                  title={r.path}
                  className="cursor-pointer truncate text-sm hover:underline"
                  onClick={() => onOpenFolder(r.path)}
                >
                  {basename(r.path)}
                </button>
                <button
                  type="button"
                  className="cursor-pointer opacity-0 transition-opacity group-hover:opacity-100"
                  onClick={() => removeRecent(r.path)}
                >
                  <IconX className="text-muted-foreground size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </main>
  );
}
```
(If `useRecentRepos`'s list field is named differently than `recent`, check `src/hooks/use-recent-repos.tsx` line ~41 and adapt.)

- [ ] **Step 3: Wrap App in the provider** — in `src/main.tsx`, import `WorkspaceProvider` from `@/hooks/use-workspace` and nest it directly inside `RecentReposProvider`, wrapping `<App />`.

- [ ] **Step 4: Replace `src/App.tsx` with:**

```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { Toaster } from "@/components/ui/sonner";
import { StatusBar } from "@/components/status-bar/status-bar";
import { Welcome } from "@/components/welcome/welcome";
import { useRepoStatus } from "@/hooks/use-repo-status";
import { useRecentRepos } from "@/hooks/use-recent-repos";
import { readLastFolder, useWorkspace } from "@/hooks/use-workspace";
import { getLaunchPath, getRepoBranch } from "@/lib/tauri";

function App() {
  const { rootPath, rootName, openFolder } = useWorkspace();
  const { workdir, status, refresh, open, close } = useRepoStatus();
  const { addRecent } = useRecentRepos();
  const [gitAvailable, setGitAvailable] = useState(false);
  const [branch, setBranch] = useState<string | null>(null);
  const restoreStartedRef = useRef(false);

  const openFolderAndRecord = useCallback(
    (path: string) => {
      openFolder(path);
      addRecent(path);
    },
    [openFolder, addRecent],
  );
  const openFolderRef = useRef(openFolderAndRecord);
  openFolderRef.current = openFolderAndRecord;

  // Restore: CLI launch path first, then last opened folder.
  useEffect(() => {
    let cancelled = false;
    getLaunchPath()
      .then((launchPath) => {
        if (cancelled || restoreStartedRef.current) return;
        const restorePath = launchPath ?? readLastFolder();
        if (!restorePath) return;
        restoreStartedRef.current = true;
        openFolderRef.current(restorePath);
      })
      .catch((e) => console.error("[maincode] getLaunchPath failed:", e));
    return () => {
      cancelled = true;
    };
  }, []);

  // Try to attach git whenever the workspace root changes. Non-repos are
  // fine — the editor works either way, git UI just stays disabled.
  const gitOpenRef = useRef(open);
  gitOpenRef.current = open;
  const gitCloseRef = useRef(close);
  gitCloseRef.current = close;
  useEffect(() => {
    if (!rootPath) {
      gitCloseRef.current();
      setGitAvailable(false);
      return;
    }
    let cancelled = false;
    gitOpenRef
      .current(rootPath)
      .then(() => {
        if (!cancelled) setGitAvailable(true);
      })
      .catch(() => {
        if (!cancelled) {
          gitCloseRef.current();
          setGitAvailable(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [rootPath]);

  // Auto-refresh git status on watcher events.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    if (!workdir) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    listen("repo:changed", () => refreshRef.current()).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [workdir]);

  // Track the current branch.
  useEffect(() => {
    if (!workdir) {
      setBranch(null);
      return;
    }
    let cancelled = false;
    getRepoBranch(workdir)
      .then((b) => {
        if (!cancelled) setBranch(b);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [workdir, status]);

  const handleBranchSwitched = useCallback(async () => {
    await refresh();
    if (!workdir) return;
    try {
      setBranch(await getRepoBranch(workdir));
    } catch {
      // ignore
    }
  }, [refresh, workdir]);

  if (!rootPath) {
    return (
      <>
        <Welcome onOpenFolder={openFolderAndRecord} />
        <Toaster />
      </>
    );
  }

  return (
    <>
      <div className="flex h-full flex-col">
        <ResizablePanelGroup
          orientation="horizontal"
          className="isolate min-h-0 flex-1 border-t border-border bg-background"
        >
          <ResizablePanel defaultSize="22%" minSize={220} maxSize={400}>
            <div className="flex h-full flex-col bg-sidebar">
              <div className="flex h-10 items-center border-b border-border px-3">
                <span className="truncate text-xs font-semibold">
                  {rootName}
                </span>
              </div>
              <div className="min-h-0 flex-1 overflow-auto p-2">
                <p className="text-muted-foreground text-xs">
                  File tree coming soon
                </p>
              </div>
            </div>
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel defaultSize="78%">
            <div className="flex h-full items-center justify-center">
              <p className="text-muted-foreground text-sm">
                Open a file from the sidebar
              </p>
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
        {gitAvailable && workdir ? (
          <StatusBar
            workdir={workdir}
            branch={branch}
            onOpenRepo={async (path: string) => {
              openFolderAndRecord(path);
              return path;
            }}
            onBranchSwitched={handleBranchSwitched}
          />
        ) : (
          <footer className="flex h-7 items-center border-t border-border px-3">
            <span className="text-muted-foreground text-xs">
              {rootName} — not a git repository
            </span>
          </footer>
        )}
      </div>
      <Toaster />
    </>
  );
}

export default App;
```
Adapt the `StatusBar` call site to its actual props if they differ (same rule as Task 3). If `useRepoStatus` has no `close`, add one there (sets workdir/status null) — check the hook first; App.tsx previously used `close`, so it exists.

- [ ] **Step 5: Verify** — `bun run typecheck` then `bun run tauri:dev`: welcome screen with Open Folder + recents; opening a git repo shows sidebar + status bar with branch; opening a non-repo folder (e.g. `~/Desktop`) shows the "not a git repository" footer instead of an error. Toast errors: none.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat: workspace context, welcome screen, folder-based app shell"`

---

### Task 9: File tree

> **REVISED 2026-07-12 (user request):** Match cub.dev's look by rendering the tree
> with the **`@pierre/trees`** `FileTree` component (built-in colored file-type icons),
> NOT a hand-rolled tree. Keep **lazy per-folder** loading and **show everything**
> (incl. node_modules). Mechanism confirmed: a path ending in `/` is a directory.
> Full API + code patterns in `.superpowers/sdd/pierre-trees-guide.md`; the executable
> brief is `.superpowers/sdd/task-9-brief.md`. The hand-rolled `<div>`-tree code below is
> **superseded** — kept only for the App.tsx wiring reference (Step 2).

**Files:**
- Create: `src/components/file-tree/file-tree.tsx`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `readDir`/`DirEntryInfo` from `@/lib/fs`; Tauri `repo:changed` event (fires only for git repos — fine).
- Produces: `<FileTree rootPath selectedPath onOpenFile refreshNonce? />`. Later tasks add file-op context menus (Task 13) via new optional props.

- [ ] **Step 1: Create `src/components/file-tree/file-tree.tsx`:**

```tsx
import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  IconChevronDown,
  IconChevronRight,
  IconFile,
  IconFolder,
  IconFolderOpen,
} from "@tabler/icons-react";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { readDir, type DirEntryInfo } from "@/lib/fs";

interface FileTreeProps {
  rootPath: string;
  selectedPath: string | null;
  onOpenFile: (path: string) => void;
  refreshNonce?: number;
}

export function FileTree({
  rootPath,
  selectedPath,
  onOpenFile,
  refreshNonce = 0,
}: FileTreeProps) {
  const [children, setChildren] = useState<Map<string, DirEntryInfo[]>>(
    new Map(),
  );
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const loadDir = useCallback(async (dirPath: string) => {
    try {
      const entries = await readDir(dirPath);
      setChildren((prev) => {
        const next = new Map(prev);
        next.set(dirPath, entries);
        return next;
      });
    } catch (e) {
      toast.error(`Failed to read ${dirPath}: ${e}`);
    }
  }, []);

  // Reset and load the root whenever the workspace changes.
  useEffect(() => {
    setChildren(new Map());
    setExpanded(new Set());
    void loadDir(rootPath);
  }, [rootPath, loadDir]);

  // Reload root + expanded dirs on explicit refresh or watcher events.
  const refreshLoaded = useCallback(() => {
    void loadDir(rootPath);
    setExpanded((current) => {
      current.forEach((dir) => void loadDir(dir));
      return current;
    });
  }, [rootPath, loadDir]);

  useEffect(() => {
    if (refreshNonce > 0) refreshLoaded();
  }, [refreshNonce, refreshLoaded]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    listen("repo:changed", () => refreshLoaded()).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [refreshLoaded]);

  const toggleDir = useCallback(
    (dirPath: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(dirPath)) {
          next.delete(dirPath);
        } else {
          next.add(dirPath);
          if (!children.has(dirPath)) void loadDir(dirPath);
        }
        return next;
      });
    },
    [children, loadDir],
  );

  const renderEntries = (dirPath: string, depth: number): ReactNode => {
    const entries = children.get(dirPath);
    if (!entries) {
      return depth === 0 ? (
        <p className="text-muted-foreground px-2 py-1 text-xs">Loading…</p>
      ) : null;
    }
    return entries.map((node) => {
      const isOpen = node.is_dir && expanded.has(node.path);
      return (
        <div key={node.path}>
          <button
            type="button"
            title={node.path}
            className={cn(
              "flex h-6 w-full cursor-pointer items-center gap-1.5 rounded-sm px-1 text-left text-xs",
              selectedPath === node.path
                ? "bg-accent text-accent-foreground"
                : "hover:bg-muted/40",
            )}
            style={{ paddingLeft: depth * 12 + 4 }}
            onClick={() =>
              node.is_dir ? toggleDir(node.path) : onOpenFile(node.path)
            }
          >
            {node.is_dir ? (
              <>
                {isOpen ? (
                  <IconChevronDown className="size-3 shrink-0" />
                ) : (
                  <IconChevronRight className="size-3 shrink-0" />
                )}
                {isOpen ? (
                  <IconFolderOpen className="size-3.5 shrink-0 text-amber-600" />
                ) : (
                  <IconFolder className="size-3.5 shrink-0 text-amber-600" />
                )}
              </>
            ) : (
              <IconFile className="text-muted-foreground ml-4 size-3.5 shrink-0" />
            )}
            <span className="truncate">{node.name}</span>
          </button>
          {isOpen && renderEntries(node.path, depth + 1)}
        </div>
      );
    });
  };

  return <div className="py-1">{renderEntries(rootPath, 0)}</div>;
}
```

- [ ] **Step 2: Wire into `src/App.tsx`** — replace the sidebar's "File tree coming soon" block with:

```tsx
<FileTree
  rootPath={rootPath}
  selectedPath={null}
  onOpenFile={(path) => toast.info(`TODO open ${path}`)}
/>
```
(imports: `FileTree`, `toast`; the `toast.info` is replaced by the editor in Task 12).

- [ ] **Step 3: Verify** — `bun run typecheck`; `bun run tauri:dev`: tree renders, folders expand/collapse lazily, dirs sort first, `.git` hidden, clicking a file shows the TODO toast.

- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat: lazy file tree sidebar"`

---

### Task 10: Editor tabs reducer (TDD)

**Files:**
- Create: `src/hooks/editor-tabs-reducer.ts`, `src/hooks/editor-tabs-reducer.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 12, 13, 18):

```ts
export interface EditorTab { path: string; name: string; content: string; savedContent: string }
export interface TabsState { tabs: EditorTab[]; activePath: string | null }
export type TabsAction =
  | { type: "open"; path: string; name: string; content: string }
  | { type: "activate"; path: string }
  | { type: "edit"; path: string; content: string }
  | { type: "markSaved"; path: string }
  | { type: "close"; path: string }
  | { type: "renamePath"; from: string; to: string; name: string };
export const initialTabsState: TabsState;
export function isDirty(tab: EditorTab): boolean;
export function tabsReducer(state: TabsState, action: TabsAction): TabsState;
```

- [ ] **Step 1: Write failing tests `src/hooks/editor-tabs-reducer.test.ts`:**

```ts
import { describe, expect, it } from "vitest";
import {
  initialTabsState,
  isDirty,
  tabsReducer,
  type TabsState,
} from "./editor-tabs-reducer";

const open = (s: TabsState, path: string, content = "x"): TabsState =>
  tabsReducer(s, { type: "open", path, name: path.split("/").pop()!, content });

describe("tabsReducer", () => {
  it("open adds a tab and activates it", () => {
    const s = open(initialTabsState, "/a.ts");
    expect(s.tabs).toHaveLength(1);
    expect(s.activePath).toBe("/a.ts");
    expect(isDirty(s.tabs[0])).toBe(false);
  });

  it("open of an existing path activates without duplicating or clobbering edits", () => {
    let s = open(initialTabsState, "/a.ts", "original");
    s = tabsReducer(s, { type: "edit", path: "/a.ts", content: "edited" });
    s = open(open(s, "/b.ts"), "/a.ts", "reloaded-from-disk");
    expect(s.tabs).toHaveLength(2);
    expect(s.activePath).toBe("/a.ts");
    expect(s.tabs[0].content).toBe("edited");
  });

  it("edit marks dirty; markSaved clears it", () => {
    let s = open(initialTabsState, "/a.ts", "one");
    s = tabsReducer(s, { type: "edit", path: "/a.ts", content: "two" });
    expect(isDirty(s.tabs[0])).toBe(true);
    s = tabsReducer(s, { type: "markSaved", path: "/a.ts" });
    expect(isDirty(s.tabs[0])).toBe(false);
    expect(s.tabs[0].savedContent).toBe("two");
  });

  it("close of the active tab activates its right neighbor, else left, else none", () => {
    let s = open(open(open(initialTabsState, "/a"), "/b"), "/c");
    s = tabsReducer(s, { type: "activate", path: "/b" });
    s = tabsReducer(s, { type: "close", path: "/b" });
    expect(s.activePath).toBe("/c");
    s = tabsReducer(s, { type: "close", path: "/c" });
    expect(s.activePath).toBe("/a");
    s = tabsReducer(s, { type: "close", path: "/a" });
    expect(s.activePath).toBeNull();
    expect(s.tabs).toHaveLength(0);
  });

  it("close of an inactive tab keeps the active tab", () => {
    let s = open(open(initialTabsState, "/a"), "/b");
    s = tabsReducer(s, { type: "close", path: "/a" });
    expect(s.activePath).toBe("/b");
  });

  it("activate of an unknown path is a no-op", () => {
    const s = open(initialTabsState, "/a");
    expect(tabsReducer(s, { type: "activate", path: "/nope" })).toBe(s);
  });

  it("renamePath updates path, name, and activePath", () => {
    let s = open(initialTabsState, "/dir/a.ts");
    s = tabsReducer(s, {
      type: "renamePath",
      from: "/dir/a.ts",
      to: "/dir/b.ts",
      name: "b.ts",
    });
    expect(s.tabs[0].path).toBe("/dir/b.ts");
    expect(s.tabs[0].name).toBe("b.ts");
    expect(s.activePath).toBe("/dir/b.ts");
  });
});
```

- [ ] **Step 2: Run to verify failure** — `bun run test` → FAIL (module not found).

- [ ] **Step 3: Implement `src/hooks/editor-tabs-reducer.ts`:**

```ts
export interface EditorTab {
  path: string;
  name: string;
  content: string;
  savedContent: string;
}

export interface TabsState {
  tabs: EditorTab[];
  activePath: string | null;
}

export type TabsAction =
  | { type: "open"; path: string; name: string; content: string }
  | { type: "activate"; path: string }
  | { type: "edit"; path: string; content: string }
  | { type: "markSaved"; path: string }
  | { type: "close"; path: string }
  | { type: "renamePath"; from: string; to: string; name: string };

export const initialTabsState: TabsState = { tabs: [], activePath: null };

export function isDirty(tab: EditorTab): boolean {
  return tab.content !== tab.savedContent;
}

export function tabsReducer(state: TabsState, action: TabsAction): TabsState {
  switch (action.type) {
    case "open": {
      if (state.tabs.some((t) => t.path === action.path)) {
        return { ...state, activePath: action.path };
      }
      const tab: EditorTab = {
        path: action.path,
        name: action.name,
        content: action.content,
        savedContent: action.content,
      };
      return { tabs: [...state.tabs, tab], activePath: action.path };
    }
    case "activate":
      if (!state.tabs.some((t) => t.path === action.path)) return state;
      return { ...state, activePath: action.path };
    case "edit":
      return {
        ...state,
        tabs: state.tabs.map((t) =>
          t.path === action.path ? { ...t, content: action.content } : t,
        ),
      };
    case "markSaved":
      return {
        ...state,
        tabs: state.tabs.map((t) =>
          t.path === action.path ? { ...t, savedContent: t.content } : t,
        ),
      };
    case "close": {
      const idx = state.tabs.findIndex((t) => t.path === action.path);
      if (idx === -1) return state;
      const tabs = state.tabs.filter((t) => t.path !== action.path);
      let activePath = state.activePath;
      if (state.activePath === action.path) {
        const next = tabs[Math.min(idx, tabs.length - 1)];
        activePath = next ? next.path : null;
      }
      return { tabs, activePath };
    }
    case "renamePath": {
      const tabs = state.tabs.map((t) =>
        t.path === action.from
          ? { ...t, path: action.to, name: action.name }
          : t,
      );
      const activePath =
        state.activePath === action.from ? action.to : state.activePath;
      return { tabs, activePath };
    }
  }
}
```

- [ ] **Step 4: Run tests** — `bun run test` → all pass (11 total with language tests).

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: editor tabs reducer"`

---

### Task 11: CodeMirror language map and editor component

**Files:**
- Create: `src/lib/cm-language.ts`, `src/components/editor/code-editor.tsx`
- Modify: `package.json` (deps), `src/App.css`

**Interfaces:**
- Consumes: `languageKeyForPath` (Task 7).
- Produces: `cmLanguageFor(key: LanguageKey | null): Extension[]`; `<CodeEditor path content onChange(path, content) onSave(path) onCursor?(line, col) />` — one persistent EditorView; per-path `EditorState` cache preserves undo history across tab switches; Cmd+S runs `onSave`; Cmd+F opens CodeMirror's search panel (find & replace, via `basicSetup`); dark theme follows the app theme.

- [ ] **Step 1: Install CodeMirror packages**

```bash
bun add codemirror @codemirror/state @codemirror/view @codemirror/commands @codemirror/theme-one-dark @codemirror/lang-javascript @codemirror/lang-python @codemirror/lang-html @codemirror/lang-css @codemirror/lang-json @codemirror/lang-markdown @codemirror/lang-rust @codemirror/lang-yaml
```

- [ ] **Step 2: Create `src/lib/cm-language.ts`:**

```ts
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { yaml } from "@codemirror/lang-yaml";
import type { Extension } from "@codemirror/state";
import type { LanguageKey } from "./language";

export function cmLanguageFor(key: LanguageKey | null): Extension[] {
  switch (key) {
    case "javascript":
      return [javascript()];
    case "jsx":
      return [javascript({ jsx: true })];
    case "typescript":
      return [javascript({ typescript: true })];
    case "tsx":
      return [javascript({ typescript: true, jsx: true })];
    case "python":
      return [python()];
    case "html":
      return [html()];
    case "css":
      return [css()];
    case "json":
      return [json()];
    case "markdown":
      return [markdown()];
    case "rust":
      return [rust()];
    case "yaml":
      return [yaml()];
    default:
      return [];
  }
}
```

- [ ] **Step 3: Create `src/components/editor/code-editor.tsx`:**

```tsx
import { useEffect, useRef } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { oneDark } from "@codemirror/theme-one-dark";
import { basicSetup } from "codemirror";
import { useTheme } from "next-themes";
import { cmLanguageFor } from "@/lib/cm-language";
import { languageKeyForPath } from "@/lib/language";

interface CodeEditorProps {
  path: string;
  /** Document text used when this path has no cached editor state yet. */
  content: string;
  onChange: (path: string, content: string) => void;
  onSave: (path: string) => void;
  onCursor?: (line: number, col: number) => void;
}

export function CodeEditor({
  path,
  content,
  onChange,
  onSave,
  onCursor,
}: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const statesRef = useRef(new Map<string, EditorState>());
  const pathRef = useRef(path);
  const themeCompartment = useRef(new Compartment());
  const langCompartment = useRef(new Compartment());
  const { resolvedTheme } = useTheme();

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const onCursorRef = useRef(onCursor);
  onCursorRef.current = onCursor;
  const darkRef = useRef(resolvedTheme === "dark");
  darkRef.current = resolvedTheme === "dark";

  const makeStateRef = useRef((docPath: string, doc: string): EditorState => {
    return EditorState.create({
      doc,
      extensions: [
        basicSetup,
        keymap.of([
          {
            key: "Mod-s",
            run: () => {
              onSaveRef.current(pathRef.current);
              return true;
            },
          },
          indentWithTab,
        ]),
        langCompartment.current.of(
          cmLanguageFor(languageKeyForPath(docPath)),
        ),
        themeCompartment.current.of(darkRef.current ? oneDark : []),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(
              pathRef.current,
              update.state.doc.toString(),
            );
          }
          if (update.selectionSet || update.docChanged) {
            const head = update.state.selection.main.head;
            const line = update.state.doc.lineAt(head);
            onCursorRef.current?.(line.number, head - line.from + 1);
          }
        }),
      ],
    });
  });

  // Create the single persistent view.
  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({
      state: makeStateRef.current(pathRef.current, content),
      parent: hostRef.current,
    });
    viewRef.current = view;
    view.focus();
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // The initial doc is only read once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Swap editor state when the active path changes, caching the old one so
  // undo history survives tab switches.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || pathRef.current === path) return;
    statesRef.current.set(pathRef.current, view.state);
    pathRef.current = path;
    const cached = statesRef.current.get(path);
    view.setState(cached ?? makeStateRef.current(path, content));
    view.focus();
  }, [path, content]);

  // Keep the theme in sync (also re-applied after state swaps, which may
  // restore a cached state configured under the old theme).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: themeCompartment.current.reconfigure(
        resolvedTheme === "dark" ? oneDark : [],
      ),
    });
  }, [resolvedTheme, path]);

  return <div ref={hostRef} className="h-full min-h-0 overflow-hidden" />;
}
```

- [ ] **Step 4: Editor CSS** — append to `src/App.css`:

```css
.cm-editor {
  height: 100%;
  font-size: 13px;
}
.cm-editor .cm-scroller {
  font-family: "App Mono", ui-monospace, monospace;
}
```

- [ ] **Step 5: Verify + commit**

```bash
bun run typecheck
git add -A && git commit -m "feat: CodeMirror editor component with language and theme support"
```
(Behavior is exercised in Task 12's manual gate.)

---

### Task 12: Editor context, tab bar, editor area, App wiring

**Files:**
- Create: `src/hooks/use-editor.tsx`, `src/components/editor/tab-bar.tsx`, `src/components/editor/editor-area.tsx`
- Modify: `src/main.tsx`, `src/App.tsx`

**Interfaces:**
- Consumes: Tasks 7, 10, 11 outputs; `ask` from `@tauri-apps/plugin-dialog`.
- Produces: `useEditor(): { tabs: EditorTab[]; activeTab: EditorTab | null; dirtyCount: number; openFile(path): Promise<void>; editFile(path, content): void; saveFile(path): Promise<void>; closeTab(path): void; activateTab(path): void; handlePathRenamed(from, to): void; isDirty(tab): boolean }`.

- [ ] **Step 1: Create `src/hooks/use-editor.tsx`:**

```tsx
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import { readFile, writeFile } from "@/lib/fs";
import { basename } from "@/hooks/use-workspace";
import {
  initialTabsState,
  isDirty,
  tabsReducer,
  type EditorTab,
  type TabsState,
} from "./editor-tabs-reducer";

interface EditorContextValue {
  tabs: EditorTab[];
  activeTab: EditorTab | null;
  dirtyCount: number;
  openFile: (path: string) => Promise<void>;
  editFile: (path: string, content: string) => void;
  saveFile: (path: string) => Promise<void>;
  closeTab: (path: string) => void;
  activateTab: (path: string) => void;
  handlePathRenamed: (from: string, to: string) => void;
  isDirty: (tab: EditorTab) => boolean;
}

const EditorContext = createContext<EditorContextValue | null>(null);

export function EditorProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(tabsReducer, initialTabsState);
  const stateRef = useRef<TabsState>(state);
  stateRef.current = state;

  const openFile = useCallback(async (path: string) => {
    // Already open → the reducer just activates it (content untouched).
    if (!stateRef.current.tabs.some((t) => t.path === path)) {
      const result = await readFile(path).catch((e) => {
        toast.error(`Failed to open: ${e}`);
        return null;
      });
      if (!result) return;
      if (result.content === null) {
        toast.error(
          result.reason === "too_large"
            ? "File is larger than 2 MB — not opening it here"
            : "Cannot open a binary file",
        );
        return;
      }
      dispatch({
        type: "open",
        path,
        name: basename(path),
        content: result.content,
      });
      return;
    }
    dispatch({ type: "open", path, name: basename(path), content: "" });
  }, []);

  const editFile = useCallback((path: string, content: string) => {
    dispatch({ type: "edit", path, content });
  }, []);

  const saveFile = useCallback(async (path: string) => {
    const tab = stateRef.current.tabs.find((t) => t.path === path);
    if (!tab) return;
    try {
      await writeFile(path, tab.content);
      dispatch({ type: "markSaved", path });
    } catch (e) {
      toast.error(`Save failed: ${e}`);
    }
  }, []);

  const closeTab = useCallback((path: string) => {
    dispatch({ type: "close", path });
  }, []);

  const activateTab = useCallback((path: string) => {
    dispatch({ type: "activate", path });
  }, []);

  const handlePathRenamed = useCallback((from: string, to: string) => {
    dispatch({ type: "renamePath", from, to, name: basename(to) });
  }, []);

  const value = useMemo<EditorContextValue>(() => {
    const activeTab =
      state.tabs.find((t) => t.path === state.activePath) ?? null;
    return {
      tabs: state.tabs,
      activeTab,
      dirtyCount: state.tabs.filter(isDirty).length,
      openFile,
      editFile,
      saveFile,
      closeTab,
      activateTab,
      handlePathRenamed,
      isDirty,
    };
  }, [
    state,
    openFile,
    editFile,
    saveFile,
    closeTab,
    activateTab,
    handlePathRenamed,
  ]);

  return (
    <EditorContext.Provider value={value}>{children}</EditorContext.Provider>
  );
}

export function useEditor(): EditorContextValue {
  const ctx = useContext(EditorContext);
  if (!ctx) throw new Error("useEditor must be used within EditorProvider");
  return ctx;
}
```

- [ ] **Step 2: Create `src/components/editor/tab-bar.tsx`:**

```tsx
import { IconX } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { isDirty, type EditorTab } from "@/hooks/editor-tabs-reducer";

interface TabBarProps {
  tabs: EditorTab[];
  activePath: string | null;
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
}

export function TabBar({ tabs, activePath, onActivate, onClose }: TabBarProps) {
  if (tabs.length === 0) return null;
  return (
    <div className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-border bg-sidebar">
      {tabs.map((tab) => {
        const active = tab.path === activePath;
        return (
          <div
            key={tab.path}
            title={tab.path}
            className={cn(
              "group flex cursor-pointer items-center gap-1.5 border-r border-border px-3 text-xs",
              active
                ? "bg-background text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => onActivate(tab.path)}
          >
            <span className="max-w-40 truncate">{tab.name}</span>
            {isDirty(tab) && (
              <span className="size-1.5 shrink-0 rounded-full bg-amber-500" />
            )}
            <button
              type="button"
              className="cursor-pointer rounded-sm p-0.5 opacity-0 transition-opacity hover:bg-muted group-hover:opacity-100"
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.path);
              }}
            >
              <IconX className="size-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 3: Create `src/components/editor/editor-area.tsx`:**

```tsx
import { useEffect, useRef } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { useEditor } from "@/hooks/use-editor";
import { CodeEditor } from "./code-editor";
import { TabBar } from "./tab-bar";

interface EditorAreaProps {
  onCursor?: (line: number, col: number) => void;
}

export function EditorArea({ onCursor }: EditorAreaProps) {
  const {
    tabs,
    activeTab,
    activateTab,
    closeTab,
    editFile,
    saveFile,
    isDirty,
  } = useEditor();

  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;

  const handleClose = async (path: string) => {
    const tab = tabsRef.current.find((t) => t.path === path);
    if (tab && isDirty(tab)) {
      const ok = await ask(`Close ${tab.name} without saving?`, {
        title: "Unsaved changes",
        kind: "warning",
      });
      if (!ok) return;
    }
    closeTab(path);
  };
  const handleCloseRef = useRef(handleClose);
  handleCloseRef.current = handleClose;

  // Cmd+W closes the active tab (CodeMirror doesn't capture it).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "w") {
        e.preventDefault();
        const active = activeTabRef.current;
        if (active) void handleCloseRef.current(active.path);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex h-full flex-col">
      <TabBar
        tabs={tabs}
        activePath={activeTab?.path ?? null}
        onActivate={activateTab}
        onClose={(path) => void handleClose(path)}
      />
      {activeTab ? (
        <div className="min-h-0 flex-1">
          <CodeEditor
            path={activeTab.path}
            content={activeTab.content}
            onChange={editFile}
            onSave={(path) => void saveFile(path)}
            onCursor={onCursor}
          />
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-muted-foreground text-sm">
            Open a file from the sidebar
          </p>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Wire up** — in `src/main.tsx` wrap `<App />` with `<EditorProvider>` (inside `WorkspaceProvider`). In `src/App.tsx`: add `const { openFile, activeTab } = useEditor();`, replace the FileTree `onOpenFile` TODO-toast with `(path) => void openFile(path)` and `selectedPath={activeTab?.path ?? null}`; replace the main-panel placeholder `<div>…Open a file…</div>` with `<EditorArea />`.

- [ ] **Step 5: Manual gate** — `bun run typecheck && bun run test`, then `bun run tauri:dev` and verify each:
  - click file in tree → opens in a tab, syntax-highlighted (try a `.ts` and a `.rs`)
  - edit → amber dirty dot appears; Cmd+S → dot clears; re-open file externally (`cat`) shows saved content
  - several tabs: switch preserves per-tab undo history (Cmd+Z after switching back)
  - close dirty tab → native confirm dialog; Cmd+W closes active tab
  - Cmd+F opens find/replace panel inside the editor; replace works
  - binary file (e.g. an icon `.png`) → toast, no tab; toggle theme in status-bar settings → editor flips to/from one-dark

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat: tabbed CodeMirror editing with save, dirty tracking, find/replace"`

---

### Task 13: File operations (context menu, create/rename/delete)

> **REVISED 2026-07-12:** Because the tree is now the `@pierre/trees` `FileTree`
> (Task 9 revision), the right-click menu must use its **`renderContextMenu`** prop
> (a custom menu, base-ui, positioned via `context.anchorRect`, portal root marked
> `data-file-tree-context-menu-root="true"`) — NOT wrapping rows in `ui/context-menu.tsx`.
> `NameDialog` and the create/rename/delete handlers below are unchanged. See
> `.superpowers/sdd/pierre-trees-guide.md` §6.

**Files:**
- Create: `src/components/file-tree/name-dialog.tsx`, `src/components/file-tree/file-tree-context-menu.tsx`
- Modify: `src/components/file-tree/file-tree.tsx`, `src/App.tsx`

**Interfaces:**
- Consumes: `createFile`, `createDir`, `renamePath`, `deletePath` (Task 7); `useEditor().handlePathRenamed/closeTab` (Task 12); `ui/context-menu.tsx`, `ui/dialog.tsx`, `ui/input.tsx`, `ui/button.tsx`.
- Produces: FileTree props extended with `onFileOp: (op: FileOp) => void` where `type FileOp = { kind: "new-file" | "new-folder"; dir: string } | { kind: "rename"; node: DirEntryInfo } | { kind: "delete"; node: DirEntryInfo }` (exported from `file-tree.tsx`); `<NameDialog open title initialValue confirmLabel onConfirm(name) onOpenChange />`.

- [ ] **Step 1: Create `src/components/file-tree/name-dialog.tsx`:**

```tsx
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

interface NameDialogProps {
  open: boolean;
  title: string;
  initialValue?: string;
  confirmLabel: string;
  onConfirm: (name: string) => void;
  onOpenChange: (open: boolean) => void;
}

export function NameDialog({
  open,
  title,
  initialValue = "",
  confirmLabel,
  onConfirm,
  onOpenChange,
}: NameDialogProps) {
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    if (open) setValue(initialValue);
  }, [open, initialValue]);

  const submit = () => {
    const name = value.trim();
    if (!name || name.includes("/")) return;
    onConfirm(name);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <Input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit}>{confirmLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```
(If `ui/dialog.tsx` lacks a `DialogFooter` export, use a plain `<div className="flex justify-end gap-2">`.)

- [ ] **Step 2: Add context menus to `file-tree.tsx`** — export the `FileOp` type; add `onFileOp: (op: FileOp) => void` to props; wrap each row `<button>` in:

```tsx
<ContextMenu>
  <ContextMenuTrigger asChild>{/* the row button */}</ContextMenuTrigger>
  <ContextMenuContent>
    {node.is_dir && (
      <>
        <ContextMenuItem
          onSelect={() => onFileOp({ kind: "new-file", dir: node.path })}
        >
          New File…
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() => onFileOp({ kind: "new-folder", dir: node.path })}
        >
          New Folder…
        </ContextMenuItem>
        <ContextMenuSeparator />
      </>
    )}
    <ContextMenuItem onSelect={() => onFileOp({ kind: "rename", node })}>
      Rename…
    </ContextMenuItem>
    <ContextMenuItem
      variant="destructive"
      onSelect={() => onFileOp({ kind: "delete", node })}
    >
      Delete
    </ContextMenuItem>
  </ContextMenuContent>
</ContextMenu>
```
(Adapt imports/exact prop names to `src/components/ui/context-menu.tsx` — check its exports; shadcn's version exports `ContextMenu`, `ContextMenuTrigger`, `ContextMenuContent`, `ContextMenuItem`, `ContextMenuSeparator`.) Also add two icon buttons in the sidebar header (App-side, Step 3) for root-level "New File…"/"New Folder…".

- [ ] **Step 3: Handle ops in `src/App.tsx`** — add state + handlers:

```tsx
const [pendingOp, setPendingOp] = useState<FileOp | null>(null);
const [treeRefreshNonce, setTreeRefreshNonce] = useState(0);
const bumpTree = () => setTreeRefreshNonce((n) => n + 1);

const handleFileOp = useCallback(async (op: FileOp) => {
  if (op.kind === "delete") {
    const isDir = op.node.is_dir;
    const ok = await ask(
      `Delete ${op.node.name}${isDir ? " and all its contents" : ""}? This cannot be undone.`,
      { title: "Delete", kind: "warning" },
    );
    if (!ok) return;
    try {
      await deletePath(op.node.path);
      closeTab(op.node.path);
      bumpTree();
    } catch (e) {
      toast.error(`Delete failed: ${e}`);
    }
    return;
  }
  setPendingOp(op); // dialogs handle new-file / new-folder / rename
}, [closeTab]);

const handleNameConfirm = useCallback(async (name: string) => {
  if (!pendingOp) return;
  try {
    if (pendingOp.kind === "new-file") {
      await createFile(`${pendingOp.dir}/${name}`);
    } else if (pendingOp.kind === "new-folder") {
      await createDir(`${pendingOp.dir}/${name}`);
    } else if (pendingOp.kind === "rename") {
      const parent = pendingOp.node.path.slice(
        0,
        pendingOp.node.path.lastIndexOf("/"),
      );
      const to = `${parent}/${name}`;
      await renamePath(pendingOp.node.path, to);
      handlePathRenamed(pendingOp.node.path, to);
    }
    bumpTree();
  } catch (e) {
    toast.error(`Operation failed: ${e}`);
  }
}, [pendingOp, handlePathRenamed]);
```
Render `<NameDialog open={pendingOp !== null} title={…by kind…} initialValue={pendingOp?.kind === "rename" ? pendingOp.node.name : ""} confirmLabel={pendingOp?.kind === "rename" ? "Rename" : "Create"} onConfirm={handleNameConfirm} onOpenChange={(o) => !o && setPendingOp(null)} />`; pass `onFileOp={handleFileOp}` and `refreshNonce={treeRefreshNonce}` to FileTree; add the two header buttons calling `handleFileOp({kind:"new-file", dir: rootPath})` / `new-folder`. Destructure `closeTab, handlePathRenamed` from `useEditor()`; import `ask`, `createFile`, `createDir`, `renamePath`, `deletePath`, `NameDialog`, `type FileOp`.
Known v1 limitation (do not fix): renaming a *folder* doesn't retarget open tabs under it.

- [ ] **Step 4: Manual gate** — dev app: right-click file/folder menus work; create file/folder appears in tree; rename an open file updates its tab; delete an open file closes its tab; delete folder confirms with "all its contents".

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: file create/rename/delete from the tree context menu"`

---

### Task 14: Source control panel and diff view

> **REVISED 2026-07-12:** The changed-files list should match cub.dev exactly by
> rendering with the **`@pierre/trees`** `FileTree` (git-status mode: `gitStatus` +
> colored icons), as cub's original `sidebar.tsx` did — NOT the hand-rolled
> `FileRow`/`Section` list in the superseded code below. Port cub's working-mode tree:
> two trees (staged, unstaged) OR one tree with a `gitStatus` map, `mapKind` →
> `GitStatus`, `initialExpansion:'open'`, selection → scroll the diff. Keep `CommitBar`,
> the stage/unstage/discard/commit handlers, and the `SidebarSwitch`. Reference:
> `.superpowers/sdd/pierre-trees-guide.md` §"Source Control panel" + cub original at
> `git show 16a8aa4:src/components/sidebar/sidebar.tsx`. The `SourceControlPanel`
> plain-list code below is **superseded** for the file list; its handler wiring stays valid.

**Files:**
- Create: `src/components/sidebar/sidebar-switch.tsx`, `src/components/source-control/source-control-panel.tsx`
- Modify: `src/App.tsx`, `src/components/diff-panel/diff-panel.tsx` (only if leftover dead props remain)

**Interfaces:**
- Consumes: `useRepoStatus().status` (`MergedRepoStatus { staged: FileEntry[]; unstaged: FileEntry[] }` — untracked already merged in as `kind: "added"`), `useDiffs(staged, unstaged)`, `stageFile/unstageFile/stageAll/unstageAll/commit/discardFile` from `@/lib/tauri`, `CommitBar` (`{ stagedCount, onCommit }`), `DiffPanel` (Task 3 surface), `FILE_STATUS` colors from `@/lib/status`.
- Produces: sidebar tab switcher (`"files" | "changes"`); `<SourceControlPanel …props below… />`; App-level `sidebarTab` state — center pane shows `DiffPanel` when `sidebarTab === "changes"`, else `EditorArea`.

- [ ] **Step 1: Create `src/components/sidebar/sidebar-switch.tsx`** (adapted from cub's deleted `sidebar-tabs.tsx`):

```tsx
import { cn } from "@/lib/utils";

export type SidebarTab = "files" | "changes";

interface SidebarSwitchProps {
  active: SidebarTab;
  changeCount: number;
  gitAvailable: boolean;
  onSelect: (tab: SidebarTab) => void;
}

const TABS: ReadonlyArray<{ id: SidebarTab; label: string }> = [
  { id: "files", label: "Files" },
  { id: "changes", label: "Changes" },
];

export function SidebarSwitch({
  active,
  changeCount,
  gitAvailable,
  onSelect,
}: SidebarSwitchProps) {
  return (
    <div className="flex h-10 w-full items-center gap-1 border-b border-border bg-sidebar px-1.5">
      {TABS.map((tab) => {
        const isActive = active === tab.id;
        const disabled = tab.id === "changes" && !gitAvailable;
        return (
          <button
            key={tab.id}
            type="button"
            disabled={disabled}
            onClick={() => onSelect(tab.id)}
            className={cn(
              "h-7 flex-1 cursor-pointer rounded-md text-xs font-medium transition-colors",
              isActive
                ? "bg-accent text-accent-foreground shadow-sm"
                : "bg-transparent text-muted-foreground hover:bg-muted/40 hover:text-foreground",
              disabled && "cursor-default opacity-40",
            )}
          >
            {tab.label}
            {tab.id === "changes" && changeCount > 0 && (
              <span className="text-muted-foreground ml-1.5 text-[10px]">
                {changeCount}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Create `src/components/source-control/source-control-panel.tsx`:**

```tsx
import { Fragment } from "react";
import {
  IconArrowBackUp,
  IconMinus,
  IconPlus,
} from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { CommitBar } from "@/components/sidebar/commit-bar";
import type { CommitOptions, FileEntry } from "@/lib/tauri";

interface SourceControlPanelProps {
  staged: FileEntry[];
  unstaged: FileEntry[];
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
  onStage: (path: string) => void;
  onUnstage: (path: string) => void;
  onStageAll: () => void;
  onUnstageAll: () => void;
  onCommit: (message: string, options?: CommitOptions) => void;
  onDiscardFile: (path: string) => void;
}

function FileRow({
  file,
  selected,
  actions,
  onSelect,
}: {
  file: FileEntry;
  selected: boolean;
  actions: React.ReactNode;
  onSelect: () => void;
}) {
  const name = file.path.slice(file.path.lastIndexOf("/") + 1);
  const dir = file.path.slice(0, file.path.lastIndexOf("/"));
  return (
    <div
      className={cn(
        "group flex h-7 cursor-pointer items-center gap-1.5 rounded-sm px-1.5 text-xs",
        selected ? "bg-accent text-accent-foreground" : "hover:bg-muted/40",
      )}
      onClick={onSelect}
      title={file.path}
    >
      <span className="truncate">{name}</span>
      {dir && (
        <span className="text-muted-foreground min-w-0 truncate text-[10px]">
          {dir}
        </span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-1">
        <span className="text-[10px] text-green-600">+{file.additions}</span>
        <span className="text-[10px] text-red-600">-{file.deletions}</span>
        <span className="hidden items-center gap-0.5 group-hover:flex">
          {actions}
        </span>
      </span>
    </div>
  );
}

function Section({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count: number;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-2">
      <div className="flex h-6 items-center justify-between px-1.5">
        <span className="text-muted-foreground text-[10px] font-semibold uppercase tracking-wide">
          {title} ({count})
        </span>
        {action}
      </div>
      {children}
    </div>
  );
}

const iconBtn =
  "cursor-pointer rounded-sm p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground";

export function SourceControlPanel({
  staged,
  unstaged,
  selectedPath,
  onSelectFile,
  onStage,
  onUnstage,
  onStageAll,
  onUnstageAll,
  onCommit,
  onDiscardFile,
}: SourceControlPanelProps) {
  const empty = staged.length === 0 && unstaged.length === 0;
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-auto p-1.5">
        {empty ? (
          <p className="text-muted-foreground px-1.5 py-2 text-xs">
            No changes
          </p>
        ) : (
          <Fragment>
            <Section
              title="Staged"
              count={staged.length}
              action={
                staged.length > 0 && (
                  <button type="button" className={iconBtn} title="Unstage all" onClick={onUnstageAll}>
                    <IconMinus className="size-3.5" />
                  </button>
                )
              }
            >
              {staged.map((f) => (
                <FileRow
                  key={`s-${f.path}`}
                  file={f}
                  selected={selectedPath === f.path}
                  onSelect={() => onSelectFile(f.path)}
                  actions={
                    <button
                      type="button"
                      className={iconBtn}
                      title="Unstage"
                      onClick={(e) => {
                        e.stopPropagation();
                        onUnstage(f.path);
                      }}
                    >
                      <IconMinus className="size-3.5" />
                    </button>
                  }
                />
              ))}
            </Section>
            <Section
              title="Changes"
              count={unstaged.length}
              action={
                unstaged.length > 0 && (
                  <button type="button" className={iconBtn} title="Stage all" onClick={onStageAll}>
                    <IconPlus className="size-3.5" />
                  </button>
                )
              }
            >
              {unstaged.map((f) => (
                <FileRow
                  key={`u-${f.path}`}
                  file={f}
                  selected={selectedPath === f.path}
                  onSelect={() => onSelectFile(f.path)}
                  actions={
                    <>
                      <button
                        type="button"
                        className={iconBtn}
                        title="Discard changes"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDiscardFile(f.path);
                        }}
                      >
                        <IconArrowBackUp className="size-3.5" />
                      </button>
                      <button
                        type="button"
                        className={iconBtn}
                        title="Stage"
                        onClick={(e) => {
                          e.stopPropagation();
                          onStage(f.path);
                        }}
                      >
                        <IconPlus className="size-3.5" />
                      </button>
                    </>
                  }
                />
              ))}
            </Section>
          </Fragment>
        )}
      </div>
      <CommitBar stagedCount={staged.length} onCommit={onCommit} />
    </div>
  );
}
```

- [ ] **Step 3: Wire into `src/App.tsx`:**
  - State: `const [sidebarTab, setSidebarTab] = useState<SidebarTab>("files");`, `const [scrollToPath, setScrollToPath] = useState<string | null>(null);`, `const [scrollNonce, setScrollNonce] = useState(0);`, `const [diffStyle, setDiffStyle] = useState<"unified" | "split">("split");`, `const [allExpanded, setAllExpanded] = useState(true);`
  - `const { diffs, loading } = useDiffs(status?.staged, status?.unstaged);`
  - `allFiles` memo (dedup staged+unstaged by path; staged wins):

```tsx
const allFiles = useMemo((): FileEntry[] => {
  if (!status) return [];
  const seen = new Set<string>();
  const files: FileEntry[] = [];
  for (const f of [...status.staged, ...status.unstaged]) {
    if (!seen.has(f.path)) {
      seen.add(f.path);
      files.push(f);
    }
  }
  return files;
}, [status]);
```
  - Sidebar: render `<SidebarSwitch active={sidebarTab} changeCount={(status?.staged.length ?? 0) + (status?.unstaged.length ?? 0)} gitAvailable={gitAvailable} onSelect={setSidebarTab} />` above the panel body; body = `sidebarTab === "files" ? <FileTree …/> : <SourceControlPanel …/>`.
  - Handlers (simple await + refresh; no optimistic maps — YAGNI for v1):

```tsx
const handleStage = useCallback(async (path: string) => {
  try { await stageFile(path); await refresh(); } catch (e) { toast.error(`Stage failed: ${e}`); }
}, [refresh]);
const handleUnstage = useCallback(async (path: string) => {
  try { await unstageFile(path); await refresh(); } catch (e) { toast.error(`Unstage failed: ${e}`); }
}, [refresh]);
const handleStageAll = useCallback(async () => {
  try { await stageAll(); await refresh(); } catch (e) { toast.error(`Stage all failed: ${e}`); }
}, [refresh]);
const handleUnstageAll = useCallback(async () => {
  try { await unstageAll(); await refresh(); } catch (e) { toast.error(`Unstage all failed: ${e}`); }
}, [refresh]);
const handleCommit = useCallback(async (message: string, options?: CommitOptions) => {
  try {
    const oid = await commit(message, options);
    toast.success(`${options?.amend ? "Amended" : "Committed"}: ${oid.slice(0, 7)}`);
    await refresh();
  } catch (e) { toast.error(`Commit failed: ${e}`); }
}, [refresh]);
const handleDiscardFile = useCallback(async (path: string) => {
  const ok = await ask(`Discard changes to ${path}? This cannot be undone.`, { title: "Discard changes", kind: "warning" });
  if (!ok) return;
  try { await discardFile(path); await refresh(); toast.success(`Discarded ${path}`); }
  catch (e) { toast.error(`Discard failed: ${e}`); }
}, [refresh]);
const handleSelectChangedFile = useCallback((path: string) => {
  setScrollToPath(path);
  setScrollNonce((n) => n + 1);
}, []);
```
  - Center pane: `sidebarTab === "changes" ? <DiffPanel files={allFiles} diffs={diffs} loading={loading} diffStyle={diffStyle} onDiffStyleChange={setDiffStyle} allExpanded={allExpanded} onToggleExpandAll={() => setAllExpanded(v => !v)} scrollToPath={scrollToPath} scrollNonce={scrollNonce} /> : <EditorArea …/>`. Keep `EditorArea` mounted but hidden (`className={cn(sidebarTab === "changes" && "hidden")}` on a wrapper div) so editor state survives tab flips — CodeMirror tolerates display:none.
  - If `DiffPanel` still has dead optional props left over from Task 3, delete them now.

- [ ] **Step 4: Manual gate** — in a repo with edits: Changes tab lists staged/unstaged with +/- counts; clicking a file scrolls the diff to it; stage/unstage/discard rows work; stage-all/unstage-all work; commit with message succeeds (toast + lists clear); untracked files appear under Changes and stage correctly; non-repo folder: Changes tab disabled; Files tab editing unaffected; flipping tabs preserves editor tabs and dirty state.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: source control panel with staging, diffs, and commit"`

---

### Task 15: Quick-open backend + command palette

**Files:**
- Create: `src/components/command-palette/command-palette.tsx`
- Modify: `src-tauri/src/fs_ops.rs`, `src-tauri/src/lib.rs`, `src/lib/fs.ts`, `src/App.tsx`

**Interfaces:**
- Consumes: `CommandDialog` etc. from `src/components/ui/command.tsx` (cmdk wrapper), `useEditor().openFile`, `useTheme().setTheme`.
- Produces: Rust `list_files_recursive(root: String, max: Option<usize>) -> Vec<String>` (relative paths, sorted, skips `.git`/`node_modules`/`target`/`dist`/`.next`, capped at 5000 default); `listFilesRecursive(root, max?)` in `fs.ts`; `<CommandPalette open onOpenChange files onOpenFile commands />` with `PaletteCommand = { id: string; label: string; run: () => void }`; Cmd+K and Cmd+P open it.

- [ ] **Step 1: Failing Rust test in `fs_ops.rs`:**

```rust
    #[test]
    fn list_files_recursive_skips_ignored_dirs_and_caps() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir_all(tmp.path().join("src/deep")).unwrap();
        fs::create_dir_all(tmp.path().join("node_modules/pkg")).unwrap();
        fs::write(tmp.path().join("src/deep/a.rs"), "x").unwrap();
        fs::write(tmp.path().join("top.txt"), "x").unwrap();
        fs::write(tmp.path().join("node_modules/pkg/skip.js"), "x").unwrap();
        let files = list_files_inner(tmp.path(), 100);
        assert_eq!(files, vec!["src/deep/a.rs", "top.txt"]);
        let capped = list_files_inner(tmp.path(), 1);
        assert_eq!(capped.len(), 1);
    }
```

- [ ] **Step 2: Run to verify failure** — `cargo test fs_ops` → FAIL.

- [ ] **Step 3: Implement in `fs_ops.rs` + register:**

```rust
const SKIP_DIRS: &[&str] = &[".git", "node_modules", "target", "dist", ".next"];

pub fn list_files_inner(root: &Path, max: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        if out.len() >= max {
            break;
        }
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            if out.len() >= max {
                break;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_dir() {
                if !SKIP_DIRS.contains(&name.as_str()) {
                    stack.push(entry.path());
                }
            } else if ft.is_file() {
                if let Ok(rel) = entry.path().strip_prefix(root) {
                    out.push(rel.to_string_lossy().to_string());
                }
            }
        }
    }
    out.sort();
    out
}

#[tauri::command]
pub fn list_files_recursive(root: String, max: Option<usize>) -> Result<Vec<String>, String> {
    Ok(list_files_inner(Path::new(&root), max.unwrap_or(5000)))
}
```
Register `fs_ops::list_files_recursive` in `lib.rs`. Add to `src/lib/fs.ts`:
```ts
export function listFilesRecursive(root: string, max?: number): Promise<string[]> {
  return invoke<string[]>("list_files_recursive", { root, max });
}
```

- [ ] **Step 4: Run tests** — `cargo test fs_ops` → all pass.

- [ ] **Step 5: Create `src/components/command-palette/command-palette.tsx`:**

```tsx
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

export interface PaletteCommand {
  id: string;
  label: string;
  run: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Workspace-relative file paths for quick open. */
  files: string[];
  onOpenFile: (relativePath: string) => void;
  commands: PaletteCommand[];
}

export function CommandPalette({
  open,
  onOpenChange,
  files,
  onOpenFile,
  commands,
}: CommandPaletteProps) {
  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Search files and commands…" />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>
        <CommandGroup heading="Commands">
          {commands.map((cmd) => (
            <CommandItem
              key={cmd.id}
              value={`cmd ${cmd.label}`}
              onSelect={() => {
                onOpenChange(false);
                cmd.run();
              }}
            >
              {cmd.label}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="Files">
          {files.map((f) => (
            <CommandItem
              key={f}
              value={f}
              onSelect={() => {
                onOpenChange(false);
                onOpenFile(f);
              }}
            >
              {f}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
```
(Check `ui/command.tsx` exports; `CommandDialog` exists — adapt names if its export list differs. cmdk virtualizes poorly beyond thousands of items; the 5000 cap keeps it workable.)

- [ ] **Step 6: Wire into `src/App.tsx`:**

```tsx
const [paletteOpen, setPaletteOpen] = useState(false);
const [paletteFiles, setPaletteFiles] = useState<string[]>([]);

useEffect(() => {
  const onKey = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "p")) {
      e.preventDefault();
      setPaletteOpen((v) => !v);
    }
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}, []);

useEffect(() => {
  if (!paletteOpen || !rootPath) return;
  listFilesRecursive(rootPath)
    .then(setPaletteFiles)
    .catch(() => setPaletteFiles([]));
}, [paletteOpen, rootPath]);
```
Commands array (memo; `setTheme` from `useTheme()` — import from `next-themes`):
```tsx
const paletteCommands = useMemo<PaletteCommand[]>(() => [
  { id: "open-folder", label: "Open Folder…", run: () => void handleOpenFolderDialog() },
  { id: "save", label: "Save Active File", run: () => { if (activeTab) void saveFile(activeTab.path); } },
  { id: "tab-files", label: "Show Files", run: () => setSidebarTab("files") },
  { id: "tab-changes", label: "Show Changes", run: () => setSidebarTab("changes") },
  { id: "theme-light", label: "Theme: Light", run: () => setTheme("light") },
  { id: "theme-dark", label: "Theme: Dark", run: () => setTheme("dark") },
  { id: "theme-system", label: "Theme: System", run: () => setTheme("system") },
], [activeTab, saveFile, setTheme]);
```
(`handleOpenFolderDialog` = the existing directory-picker helper; add one if App no longer has it: `openDialog({ directory: true }) → openFolderAndRecord`. Destructure `saveFile` from `useEditor()`.) Render `<CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} files={paletteFiles} onOpenFile={(rel) => void openFile(`${rootPath}/${rel}`)} commands={paletteCommands} />`.

- [ ] **Step 7: Manual gate** — Cmd+K opens palette; typing filters files and commands; selecting a file opens it in the editor (Files tab); theme commands work; Cmd+P also opens.

- [ ] **Step 8: Commit** — `git add -A && git commit -m "feat: command palette with quick open and commands"`

---

### Task 16: pty.rs — terminal backend (TDD smoke)

**Files:**
- Create: `src-tauri/src/pty.rs`
- Modify: `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`

**Interfaces:**
- Produces: commands `pty_spawn(cwd: String, cols: u16, rows: u16) -> u32` (session id), `pty_write(id: u32, data: String)`, `pty_resize(id: u32, cols: u16, rows: u16)`, `pty_kill(id: u32)`; events `pty-output-{id}` (payload: String chunk) and `pty-exit-{id}` (payload: null). Managed state `PtyState`.

- [ ] **Step 1: Add dependency** — `portable-pty = "0.9"` under `[dependencies]` in `src-tauri/Cargo.toml`.

- [ ] **Step 2: Create `src-tauri/src/pty.rs` with the smoke test first:**

```rust
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

pub struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

pub struct PtyState {
    pub sessions: Mutex<HashMap<u32, PtySession>>,
    pub next_id: AtomicU32,
}

impl Default for PtyState {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            next_id: AtomicU32::new(1),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pty_pair_runs_a_command_and_produces_output() {
        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .unwrap();
        let mut cmd = CommandBuilder::new("/bin/echo");
        cmd.arg("hello-pty");
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut out = String::new();
        let _ = reader.read_to_string(&mut out);
        child.wait().unwrap();
        assert!(out.contains("hello-pty"), "got: {out:?}");
    }
}
```

- [ ] **Step 3: Register module and run the test** — add `mod pty;` to `lib.rs`, then `cargo test pty` → PASS (this validates portable-pty on the platform; if `read_to_string` hangs >30s, replace with a bounded read loop and re-run).

- [ ] **Step 4: Implement the commands (above the test module):**

```rust
/// Decode as much of `carry` as is valid UTF-8, keeping an incomplete
/// trailing sequence (≤4 bytes) for the next chunk.
fn drain_utf8(carry: &mut Vec<u8>) -> String {
    match std::str::from_utf8(carry) {
        Ok(s) => {
            let out = s.to_string();
            carry.clear();
            out
        }
        Err(e) => {
            let valid = e.valid_up_to();
            let out = String::from_utf8_lossy(&carry[..valid]).to_string();
            carry.drain(..valid);
            if carry.len() > 4 {
                // Not a split sequence — genuinely invalid bytes; flush lossily.
                let rest = String::from_utf8_lossy(carry).to_string();
                carry.clear();
                return out + &rest;
            }
            out
        }
    }
}

#[tauri::command]
pub fn pty_spawn(
    cwd: String,
    cols: u16,
    rows: u16,
    app: AppHandle,
    state: State<PtyState>,
) -> Result<u32, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut cmd = CommandBuilder::new(&shell);
    cmd.cwd(&cwd);
    cmd.env("TERM", "xterm-256color");
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let killer = child.clone_killer();
    let id = state.next_id.fetch_add(1, Ordering::SeqCst);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let app_out = app.clone();
    std::thread::spawn(move || {
        let mut carry: Vec<u8> = Vec::new();
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    carry.extend_from_slice(&buf[..n]);
                    let text = drain_utf8(&mut carry);
                    if !text.is_empty() {
                        let _ = app_out.emit(&format!("pty-output-{id}"), text);
                    }
                }
            }
        }
        let _ = app_out.emit(&format!("pty-exit-{id}"), ());
    });

    // Reap the child so it doesn't zombie.
    std::thread::spawn(move || {
        let _ = child.wait();
    });

    state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id, PtySession { master: pair.master, writer, killer });
    Ok(id)
}

#[tauri::command]
pub fn pty_write(id: u32, data: String, state: State<PtyState>) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions.get_mut(&id).ok_or("no such pty session")?;
    session.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(id: u32, cols: u16, rows: u16, state: State<PtyState>) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions.get(&id).ok_or("no such pty session")?;
    session
        .master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(id: u32, state: State<PtyState>) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    if let Some(mut session) = sessions.remove(&id) {
        let _ = session.killer.kill();
    }
    Ok(())
}
```

- [ ] **Step 5: Register in `lib.rs`** — add `.manage(pty::PtyState::default())` after the existing `.manage(...)`, and `pty::pty_spawn, pty::pty_write, pty::pty_resize, pty::pty_kill,` to `generate_handler!`. (Adjust to actual portable-pty 0.9 API if names moved — `cargo check` is the arbiter.)

- [ ] **Step 6: Verify + commit**

```bash
cd src-tauri && cargo check && cargo test && cd ..
git add -A && git commit -m "feat: pty backend for the integrated terminal"
```

---

### Task 17: Terminal panel UI

**Files:**
- Create: `src/components/terminal/terminal-panel.tsx`
- Modify: `package.json` (deps), `src/App.tsx`

**Interfaces:**
- Consumes: Task 16's commands/events; `useWorkspace().rootPath`.
- Produces: `<TerminalPanel cwd />`; App state `showTerminal` toggled by Ctrl+` and a palette command. One shell session per panel mount (closing the panel kills the session — accepted v1 tradeoff).

- [ ] **Step 1: Install xterm**

```bash
bun add @xterm/xterm @xterm/addon-fit
```

- [ ] **Step 2: Create `src/components/terminal/terminal-panel.tsx`:**

```tsx
import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface TerminalPanelProps {
  cwd: string;
}

export function TerminalPanel({ cwd }: TerminalPanelProps) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontSize: 12,
      fontFamily: '"App Mono", ui-monospace, monospace',
      cursorBlink: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    let id: number | null = null;
    let unlistenOut: (() => void) | null = null;
    let unlistenExit: (() => void) | null = null;
    let disposed = false;

    invoke<number>("pty_spawn", { cwd, cols: term.cols, rows: term.rows })
      .then(async (ptyId) => {
        if (disposed) {
          void invoke("pty_kill", { id: ptyId });
          return;
        }
        id = ptyId;
        unlistenOut = await listen<string>(`pty-output-${ptyId}`, (e) =>
          term.write(e.payload),
        );
        unlistenExit = await listen(`pty-exit-${ptyId}`, () =>
          term.write("\r\n[process exited]\r\n"),
        );
      })
      .catch((e) => term.write(`\r\nfailed to start shell: ${e}\r\n`));

    const dataSub = term.onData((data) => {
      if (id !== null) void invoke("pty_write", { id, data });
    });

    const ro = new ResizeObserver(() => {
      fit.fit();
      if (id !== null) {
        void invoke("pty_resize", { id, cols: term.cols, rows: term.rows });
      }
    });
    ro.observe(host);

    return () => {
      disposed = true;
      ro.disconnect();
      dataSub.dispose();
      unlistenOut?.();
      unlistenExit?.();
      if (id !== null) void invoke("pty_kill", { id });
      term.dispose();
    };
  }, [cwd]);

  return <div ref={hostRef} className="h-full w-full px-2 pt-1" />;
}
```

- [ ] **Step 3: Wire into `src/App.tsx`** — add `const [showTerminal, setShowTerminal] = useState(false);`; Ctrl+` toggle in the existing keydown effect (`` e.ctrlKey && e.key === "`" ``); palette command `{ id: "toggle-terminal", label: "Toggle Terminal", run: () => setShowTerminal(v => !v) }`. Wrap the center pane in a vertical split:

```tsx
<ResizablePanelGroup orientation="vertical">
  <ResizablePanel defaultSize="70%">{/* existing EditorArea/DiffPanel */}</ResizablePanel>
  {showTerminal && (
    <>
      <ResizableHandle />
      <ResizablePanel defaultSize="30%" minSize={100}>
        <TerminalPanel cwd={rootPath} />
      </ResizablePanel>
    </>
  )}
</ResizablePanelGroup>
```
(Adapt `orientation`/size props to `ui/resizable.tsx`'s actual API — mirror how the horizontal group is used.)

- [ ] **Step 4: Manual gate** — Ctrl+` shows terminal running your shell in the workspace cwd; `ls`, arrows, and `vim` render correctly; resizing the split reflows (`echo $COLUMNS` changes); closing the panel and reopening starts a fresh shell; quitting the app doesn't hang.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: integrated terminal panel (xterm + pty)"`

---

### Task 18: Status bar polish, README, final verification

**Files:**
- Modify: `src/components/status-bar/status-bar.tsx`, `src/App.tsx`, `README.md`

**Interfaces:**
- Consumes: `useEditor().dirtyCount/activeTab`, `CodeEditor onCursor`, `LANGUAGE_LABELS`/`languageKeyForPath`.
- Produces: StatusBar right side shows `Ln X, Col Y · <Language> · N unsaved` for the active tab; StatusBar renders for non-git folders too (branch UI hidden), replacing the Task 8 fallback footer.

- [ ] **Step 1: Extend `status-bar.tsx`** — add optional props to `StatusBarProps`: `cursor?: { line: number; col: number } | null`, `languageLabel?: string | null`, `dirtyCount?: number`, `gitAvailable?: boolean` (default true). Render a right-aligned segment (inside the existing bar container, matching its text styles):

```tsx
<span className="text-muted-foreground ml-auto flex items-center gap-3 text-xs">
  {cursor && <span>Ln {cursor.line}, Col {cursor.col}</span>}
  {languageLabel && <span>{languageLabel}</span>}
  {(dirtyCount ?? 0) > 0 && <span>{dirtyCount} unsaved</span>}
</span>
```
Gate the branch-switcher popover (and any other git-only UI) on `gitAvailable`; make `branch` display show nothing when `null`.

- [ ] **Step 2: App wiring** — track `const [cursor, setCursor] = useState<{line: number; col: number} | null>(null);`, pass `onCursor={(line, col) => setCursor({ line, col })}` to `EditorArea`→`CodeEditor`; compute `languageLabel` from `activeTab` via `languageKeyForPath` + `LANGUAGE_LABELS`; pass `dirtyCount` from `useEditor()`; delete the Task 8 "not a git repository" fallback footer and always render `<StatusBar workdir={rootPath} gitAvailable={gitAvailable} …/>` (update `StatusBarProps.workdir` usage accordingly — it's a display path now).

- [ ] **Step 3: Rewrite `README.md`:**

```markdown
# Maincode

A simple desktop code editor. Built on Tauri v2 + React + CodeMirror 6,
derived from [cub.dev](https://github.com/ephraimduncan/cub.dev).

## Features

- Open any folder: file tree, tabs, syntax highlighting, find & replace (Cmd+F)
- File operations from the tree (create / rename / delete)
- Command palette (Cmd+K / Cmd+P): quick-open files, commands, theme
- Source control for git repos: stage, unstage, discard, diff view, commit,
  branch switching
- Integrated terminal (Ctrl+`)

## Development

Requires [Bun](https://bun.sh) and the [Rust toolchain](https://rustup.rs).

​```bash
bun install
bun run tauri:dev      # hot-reloading dev build
bun run tauri build    # production bundle
bun run test           # frontend unit tests
(cd src-tauri && cargo test)  # backend tests
​```

## License

MIT — original work © Ephraim Duncan (cub.dev), modifications © Morpheusdesk.
```
(Remove the zero-width characters around the code fence when writing the file.)

- [ ] **Step 4: Full verification**

```bash
bun run typecheck && bun run test && (cd src-tauri && cargo test) && bun run tauri build
```
Expected: all green; `tauri build` produces a bundle under `src-tauri/target/release/bundle`. Then run the dev app once more through the Task 12/14/15/17 manual gates end-to-end (open folder → edit/save → stage → commit → palette → terminal).

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: status bar details, README, v0.1.0 polish"`

---

## Known v1 limitations (accepted, do not gold-plate)

- Renaming a folder doesn't retarget open tabs under it.
- Closing the terminal panel kills its shell session.
- No optimistic staging UI (each stage/unstage waits for a status refresh).
- File watcher (auto-refresh of tree/status) only runs for git repos, since it's attached by `open_repo`.
- `read_file` caps at 2 MB; larger/binary files don't open.
