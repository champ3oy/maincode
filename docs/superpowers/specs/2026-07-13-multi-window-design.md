# Multi-Window (Native, Zed-style) — Design

**Goal:** Let a single Maincode process manage multiple editor windows, each with
its own independent project (file tree, git panel, terminals). "New Window"
(`⇧⌘N`) opens an empty window on the Welcome screen.

**Chosen approach:** Native in-app multi-window using Tauri's multiple
`WebviewWindow`s in one process — the same one-app-many-windows model Zed and
VS Code use. (The rejected alternative was spawning a separate OS process per
window; it reaches the same user-visible result with less work but is not how
those editors are built.)

## Background: current architecture

- **Stateless, already multi-window-safe:** all `fs_ops` commands (`read_dir`,
  `read_file`, `write_file`, `create_file`, `create_dir`, `rename_path`,
  `delete_path`, `list_files_recursive`, `search_file_contents`) take a path
  and do the work — no shared state.
- **Terminals, already effectively safe:** `PtyState` keys terminals by a
  globally-unique `AtomicU64` id; pty output is emitted on per-id event names
  (`pty-output-{id}`), so only the owning window's listener matches. We will
  additionally emit to the owning window for correctness.
- **Single-project globals that collide across windows (the work):**
  - `AppState { repo: Mutex<Option<Repository>>, watcher, watcher_generation }`
    holds exactly one open repository. Two windows = two projects = conflict.
  - The file watcher is single and broadcasts `repo:changed`.
  - `on_menu_event` **broadcasts** `menu-action` to every window, so a menu
    action (Save, New File, …) would fire in all windows at once.
  - `LAUNCH_PATH` is a single global; every window's startup effect
    (`App.tsx` ~line 370) restores the launch path or the last-opened folder,
    so a new window would auto-open a project instead of starting empty.

## Design

### 1. Window model

- One process, N `WebviewWindow`s. Labels: the first window keeps `main`; each
  new window gets `w-1`, `w-2`, … from an `AtomicU64` counter (stored in a
  `OnceLock`/state, mirroring the existing `LAUNCH_PATH` pattern).
- A window's project state stays entirely in that window's React tree
  (`useWorkspace`) — no shared frontend state is introduced.
- Backend commands identify the caller via an injected `tauri::WebviewWindow`
  parameter and use `window.label()` as the state key.

### 2. Backend: per-window state (core refactor)

Replace the single-project `AppState` with a per-label map:

```rust
pub struct WindowState {
    pub repo: Option<git2::Repository>,
    pub watcher: Option<notify::RecommendedWatcher>, // or current watcher type
    pub watcher_generation: AtomicU64,
}

pub struct AppState {
    pub windows: Mutex<HashMap<String, WindowState>>,
}
```

- `Mutex<HashMap<String, WindowState>>` is `Send + Sync` (the `Mutex` provides
  `Sync`; `Repository` is `Send`), so it remains `.manage`-able.
- Every git command in `git.rs` gains a `window: tauri::WebviewWindow`
  parameter and operates on `windows.get_mut(window.label())`:
  `open_repo`, `get_repo_status`, `get_file_contents_batch`, `stage_file`,
  `unstage_file`, `stage_all`, `unstage_all`, `commit`, `get_repo_branch`,
  `discard_file`, `list_branches`, `checkout_branch`. `open_repo` inserts or
  replaces the entry for that label. A command called for a label with no repo
  returns the same "no repo" result it returns today.
- The file watcher moves into `WindowState`. When a window opens a repo, its
  watcher is (re)started for that directory and emits `repo:changed`
  **to that window only** (`window.emit("repo:changed", …)` instead of a
  broadcast). `watcher_generation` stays per-window to invalidate stale events.
- **Cleanup:** on `WindowEvent::CloseRequested`/`Destroyed`, remove that
  label's `WindowState` from the map so its watcher thread stops.

### 3. Menu & New Window

- **Focused-window routing:** `on_menu_event` finds the focused window and
  emits `menu-action` only to it — e.g. iterate `app.webview_windows()` and
  pick the one whose `is_focused()` is true (fallback: the `main` window).
  This makes Save / New File / Save All / Close Editor / Command Palette /
  Search Files / Toggle Terminal act on the active window.
- **New Window item:** add **File → New Window** with id `new-window` and
  accelerator `⇧⌘N`, placed above New File. It is handled entirely in Rust in
  `on_menu_event`: build a new `WebviewWindow` via `WebviewWindowBuilder::new(
  app, next_label, WebviewUrl::App("index.html".into()))` with the same config
  as `main` (title `Maincode`, inner size 1200×800, min 1200×800,
  `title_bar_style(Overlay)`, `hidden_title(true)`). No launch path is set, so
  the window opens empty. New Window does not round-trip through the frontend.
- **Window menu (nice-to-have, deferrable):** keep the current `minimize` /
  `fullscreen` items; optionally add a New Window shortcut mirror here later.

### 4. Frontend: empty new windows

- Gate the restore effect (`App.tsx` ~line 370) so it runs only for the
  primary window: `if (getCurrentWindow().label !== "main") return;`. Only the
  `main` window restores the CLI launch path or last folder; every New Window
  starts on the Welcome screen with `rootPath === null`.
- `maincode:last-folder` (localStorage, shared across windows of the same
  origin) stays as-is; it now only records "the most recent folder opened
  anywhere," which is harmless because new windows no longer auto-restore.
- The existing `menu-action` listener is unchanged in shape; it now simply
  receives only the events targeted at the focused window.

### 5. Terminals & file ops

- File ops: unchanged.
- `pty_spawn` gains the `window` parameter and emits `pty-output-{id}` /
  `pty-exit-{id}` to that window (`window.emit`) rather than the whole app.
  Behavior is unchanged for users; this just scopes events to the owner.

## Decisions / out of scope (v1)

- **Closing the last window quits the app** (simple and common for editors).
  macOS "stay alive with no windows" behavior can be added later.
- **No new unsaved-changes-on-close prompt.** The current single-window app
  does not prompt either; adding a prompt is a separate task.
- **Window menu listing all open windows** is deferred; not required for the
  goal.

## Files touched

- `src-tauri/src/lib.rs` — new `AppState` shape; window-label counter;
  `on_menu_event` focused-window routing + `new-window` handler that builds a
  window; per-window cleanup on close.
- `src-tauri/src/git.rs` — `AppState`/`WindowState` structs; every command
  takes `window` and keys by `window.label()`.
- `src-tauri/src/watcher.rs` — per-window watcher; emit `repo:changed` to the
  owning window; per-window generation.
- `src-tauri/src/menu.rs` — add **File → New Window** (`⇧⌘N`).
- `src-tauri/src/pty.rs` — `pty_spawn` takes `window`; emit to that window.
- `src/App.tsx` — gate the restore effect on `label === "main"`.

## Testing

- **Rust unit tests** for the per-window state map: insert repos under labels
  `main` and `w-1`, assert operations on one label do not affect the other,
  and that removing a label drops its state.
- **Manual e2e:** open two windows on two different projects and verify
  independent file trees, git panels, and terminals; verify a menu action
  (e.g. Save) affects only the focused window; verify New Window opens empty;
  verify closing a window stops its watcher and does not disturb the other.
