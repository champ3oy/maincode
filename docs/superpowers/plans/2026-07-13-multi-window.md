# Multi-Window (Native, Zed-style) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one Maincode process manage multiple editor windows, each with its own independent project; `File → New Window` (`⇧⌘N`) opens an empty window.

**Architecture:** Tauri multi-window (multiple `WebviewWindow`s in one process). Per-window backend state is keyed by window label: git repo + file watcher move from a single global into a `HashMap<label, Arc<WindowState>>`. Menu actions and watcher events are routed to the specific/focused window instead of broadcast. The frontend restores a project only in the primary (`main`) window.

**Tech Stack:** Rust + Tauri v2, `git2`, `notify`/`notify_debouncer_full`, `portable-pty`; React 19 + Vite frontend.

## Global Constraints

- Platform: macOS on Apple Silicon; Tauri v2. No new dependencies.
- The primary window's label is `main` (Tauri's default for the window declared in `tauri.conf.json`).
- New windows open **empty** (Welcome screen) — they do not restore the CLI launch path or last folder.
- New windows must match the main window's config exactly: title `Maincode`, inner size `1200×800`, min inner size `1200×800`, `TitleBarStyle::Overlay`, hidden title.
- New Window accelerator: `CmdOrCtrl+Shift+N`.
- Closing the last window quits the app (Tauri default — add no special handling). No unsaved-changes prompt on close.
- Backend commands identify their window via an injected `tauri::WebviewWindow` param and key state on `window.label()`. JavaScript `invoke` calls pass no `window` argument — Tauri injects it — so no frontend `invoke` call sites change.

---

### Task 1: Per-window backend state + git command refactor

Replace the single-project `AppState` with a per-window map, thread the calling window through every stateful git command, and scope the watcher's `repo:changed` event to its window. This is one atomic refactor: the `AppState` type change ripples through all git commands, the watcher, and `lib.rs`, so it must land together and compile as a unit.

**Files:**
- Modify: `src-tauri/src/git.rs` (AppState/WindowState, `restart_watcher`, all stateful commands, `checkout_branch` emit, tests)
- Modify: `src-tauri/src/watcher.rs:18-51` (`start` takes a window label, emits to that window)
- Modify: `src-tauri/src/lib.rs` (`.manage(AppState::default())`, exit handler clears the map, imports)
- Test: `src-tauri/src/git.rs` `#[cfg(test)] mod tests`

**Interfaces:**
- Produces:
  - `pub struct WindowState { pub repo: Mutex<Option<Repository>>, pub watcher: Mutex<Option<crate::watcher::RepoWatcher>>, pub watcher_generation: AtomicU64 }` (derives `Default`)
  - `pub struct AppState { pub windows: Mutex<HashMap<String, Arc<WindowState>>> }` (derives `Default`) with `pub fn window(&self, label: &str) -> Arc<WindowState>` and `pub fn remove_window(&self, label: &str)`
  - `pub fn start(workdir: &Path, app: AppHandle, label: String) -> Result<RepoWatcher, String>` (watcher.rs)
  - Every stateful git command now takes a `window: tauri::WebviewWindow` parameter.
- Consumes: nothing new.

- [ ] **Step 1: Write the failing test**

Add to the existing `#[cfg(test)] mod tests` in `src-tauri/src/git.rs` (below the `patch_lines_keep_diff_origins` test):

```rust
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
```

- [ ] **Step 2: Run the test to verify it fails to compile**

Run: `cd src-tauri && cargo test window_state_is_isolated_per_label`
Expected: FAIL — compile error (`AppState` has no method `window`/`remove_window`; no `WindowState`).

- [ ] **Step 3: Replace the `AppState` definition with the per-window container**

In `src-tauri/src/git.rs`, add `use std::sync::Arc;` to the imports, and replace the current struct (lines 32-36):

```rust
pub struct AppState {
    pub repo: Mutex<Option<Repository>>,
    pub watcher: Mutex<Option<crate::watcher::RepoWatcher>>,
    pub watcher_generation: AtomicU64,
}
```

with:

```rust
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
```

- [ ] **Step 4: Rewrite `restart_watcher` to operate on a `WindowState`**

Replace the entire `restart_watcher` function (git.rs lines 38-145) with this version (it drops the temporary perf instrumentation the old code flagged as removable, and keys off the per-window `Arc`):

```rust
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
```

- [ ] **Step 5: Update `open_repo` to use the per-window state**

In `open_repo` (git.rs ~line 269): change the signature to add `window`, look up the window state, replace `state.repo.lock()` with `ws.repo.lock()`, and pass `&ws` + label to `restart_watcher`.

Signature becomes:

```rust
#[tauri::command]
pub fn open_repo(
    path: String,
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<AppState>,
) -> Result<String, String> {
```

Immediately after the signature's opening brace, add:

```rust
    let ws = state.window(window.label());
```

Change `let mut guard = match state.repo.lock() {` to `let mut guard = match ws.repo.lock() {`.

Change the `restart_watcher` call from `restart_watcher(&app, state.inner(), &workdir_path);` to:

```rust
    restart_watcher(&app, &ws, window.label(), &workdir_path);
```

- [ ] **Step 6: Thread `window` through the remaining stateful commands**

Apply the **identical pattern** to each command below: (a) add `window: tauri::WebviewWindow` to the parameter list; (b) as the first line of the body, add `let ws = state.window(window.label());`; (c) replace `state.repo.lock()` with `ws.repo.lock()`. Nothing else in these bodies changes. Their exact new signatures:

```rust
#[tauri::command]
pub fn get_repo_status(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<AppState>,
) -> Result<RepoStatus, String> {

#[tauri::command]
pub fn get_file_contents_batch(
    requests: Vec<FileContentsRequest>,
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<AppState>,
) -> Result<Vec<FileContentsBatchItem>, String> {

#[tauri::command]
pub fn stage_file(
    path: String,
    window: tauri::WebviewWindow,
    state: State<AppState>,
) -> Result<(), String> {

#[tauri::command]
pub fn stage_all(window: tauri::WebviewWindow, state: State<AppState>) -> Result<(), String> {

#[tauri::command]
pub fn unstage_file(
    path: String,
    window: tauri::WebviewWindow,
    state: State<AppState>,
) -> Result<(), String> {

#[tauri::command]
pub fn unstage_all(window: tauri::WebviewWindow, state: State<AppState>) -> Result<(), String> {

#[tauri::command]
pub fn discard_file(
    path: String,
    window: tauri::WebviewWindow,
    state: State<AppState>,
) -> Result<(), String> {

#[tauri::command]
pub fn commit(
    message: String,
    amend: Option<bool>,
    window: tauri::WebviewWindow,
    state: State<AppState>,
) -> Result<String, String> {

#[tauri::command]
pub fn list_branches(
    window: tauri::WebviewWindow,
    state: State<AppState>,
) -> Result<Vec<BranchInfo>, String> {
```

For each of the nine commands above, the body's `let lock = state.repo.lock()...` (or `let lock = state.repo.lock().map_err(...)` on one line) becomes `let lock = ws.repo.lock()...` and is preceded by `let ws = state.window(window.label());`. Example — `stage_file` in full after the change:

```rust
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
```

**Do not touch `get_repo_branch`** — it opens a repo directly from a path and holds no state.

- [ ] **Step 7: Update `checkout_branch` (state + scoped refresh event)**

`checkout_branch` (git.rs ~line 1306) currently takes `name`, `app`, `state`. Change its signature to:

```rust
#[tauri::command]
pub fn checkout_branch(
    name: String,
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<AppState>,
) -> Result<(), String> {
```

Add `let ws = state.window(window.label());` as the first body line and change `let lock = state.repo.lock()...` to `let lock = ws.repo.lock()...`. Finally, change the explicit refresh at the end from:

```rust
    let _ = app.emit("repo:changed", json!({}));
```

to emit only to this window:

```rust
    let _ = app.emit_to(window.label(), "repo:changed", json!({}));
```

- [ ] **Step 8: Scope the watcher event to its window**

In `src-tauri/src/watcher.rs`, change `start` (line 18) to accept a label and emit only to that window. New signature and emit:

```rust
pub fn start(workdir: &Path, app: AppHandle, label: String) -> Result<RepoWatcher, String> {
```

Inside the debouncer closure, replace `let _ = app.emit("repo:changed", ());` (line 30) with:

```rust
                    let _ = app.emit_to(label.as_str(), "repo:changed", ());
```

(The closure is `move`, so it captures `label`; `app` is already captured. No other changes in this file.)

- [ ] **Step 9: Update `lib.rs` state registration, exit cleanup, and imports**

In `src-tauri/src/lib.rs`:

Change the imports `use std::sync::atomic::AtomicU64;` and `use std::sync::{Mutex, OnceLock};` to just:

```rust
use std::sync::OnceLock;
```

Replace the `.manage(AppState { … })` block:

```rust
        .manage(AppState {
            repo: Mutex::new(None),
            watcher: Mutex::new(None),
            watcher_generation: AtomicU64::new(0),
        })
```

with:

```rust
        .manage(AppState::default())
```

Replace the exit handler body (the `RunEvent::Exit` arm) with one that clears all windows' state (dropping their watchers):

```rust
    app.run(move |app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            let state: tauri::State<AppState> = app_handle.state::<AppState>();
            if let Ok(mut map) = state.windows.lock() {
                map.clear();
            }
        }
    });
```

- [ ] **Step 10: Remove now-unused imports flagged by the compiler**

In `src-tauri/src/git.rs`, `use tauri::{AppHandle, Emitter, Manager, State};` — `Manager` is no longer used after Step 4 (the old watcher thread's `app.state::<AppState>()` is gone). Keep `Emitter` (used by `emit_to`). Change the import to:

```rust
use tauri::{AppHandle, Emitter, State};
```

- [ ] **Step 11: Build and run the full backend test suite**

Run: `cd src-tauri && cargo test`
Expected: PASS — `window_state_is_isolated_per_label`, `patch_lines_keep_diff_origins`, the `pty` and `fs_ops` tests all pass, no warnings about unused `Manager`/`Mutex`/`AtomicU64`.

- [ ] **Step 12: Commit**

```bash
git add src-tauri/src/git.rs src-tauri/src/watcher.rs src-tauri/src/lib.rs
git commit -m "refactor: per-window git + watcher state keyed by window label"
```

---

### Task 2: New Window menu item, window creation, focused-window routing, and close cleanup

Add `File → New Window`, create the window in Rust, route all other menu actions to the *focused* window, and drop a window's state when it closes.

**Files:**
- Modify: `src-tauri/src/menu.rs` (New Window item; `open_new_window`; label counter)
- Modify: `src-tauri/src/lib.rs` (`on_menu_event` routing + `new-window`; `on_window_event` cleanup)

**Interfaces:**
- Consumes: `AppState::remove_window` and window labels from Task 1.
- Produces: `pub fn open_new_window<R: tauri::Runtime>(app: &AppHandle<R>) -> tauri::Result<()>` in `menu.rs`.

- [ ] **Step 1: Add the New Window menu item**

In `src-tauri/src/menu.rs`, inside `build_menu`, add the item just before `new_file` is defined:

```rust
    let new_window = MenuItemBuilder::with_id("new-window", "New Window")
        .accelerator("CmdOrCtrl+Shift+N")
        .build(app)?;
```

Then add it to the File submenu as the first item, with a separator before New File. Change the `file_menu` builder to:

```rust
    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&new_window)
        .separator()
        .item(&new_file)
        .item(&open_folder)
        .separator()
        .item(&save)
        .item(&save_all)
        .separator()
        .item(&close_editor)
        .item(&close_folder)
        .build()?;
```

- [ ] **Step 2: Add the window-label counter and `open_new_window`**

At the top of `src-tauri/src/menu.rs`, add imports and a counter:

```rust
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{TitleBarStyle, WebviewUrl, WebviewWindowBuilder};

static WINDOW_COUNTER: AtomicU64 = AtomicU64::new(1);

fn next_window_label() -> String {
    format!("w-{}", WINDOW_COUNTER.fetch_add(1, Ordering::SeqCst))
}
```

(Keep the existing `use tauri::menu::{...};` and `use tauri::{AppHandle, Runtime};` lines; merge the new `tauri::{…}` items into the existing `use tauri::{AppHandle, Runtime};` if you prefer a single line.)

Then add, at the end of `menu.rs`:

```rust
/// Open a new empty editor window, matching the primary window's config.
pub fn open_new_window<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let label = next_window_label();
    WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title("Maincode")
        .inner_size(1200.0, 800.0)
        .min_inner_size(1200.0, 800.0)
        .title_bar_style(TitleBarStyle::Overlay)
        .hidden_title(true)
        .build()?;
    Ok(())
}
```

- [ ] **Step 3: Route menu events to the focused window and handle `new-window`**

In `src-tauri/src/lib.rs`, add a helper above `run()`:

```rust
/// The label of the currently focused window, falling back to `main`.
fn focused_window_label(app: &tauri::AppHandle) -> String {
    app.webview_windows()
        .into_iter()
        .find(|(_, w)| w.is_focused().unwrap_or(false))
        .map(|(label, _)| label)
        .unwrap_or_else(|| "main".to_string())
}
```

Replace the current `.on_menu_event(...)` block:

```rust
        .on_menu_event(|app, event| {
            // Forward custom menu-item ids to the frontend; predefined items
            // (copy/paste/quit/…) are handled natively.
            let _ = app.emit("menu-action", event.id().0.as_str());
        })
```

with:

```rust
        .on_menu_event(|app, event| {
            let id = event.id().0.as_str();
            if id == "new-window" {
                if let Err(e) = menu::open_new_window(app) {
                    eprintln!("[maincode] failed to open new window: {e}");
                }
                return;
            }
            // Forward every other custom action to the focused window only, so
            // Save / New File / Toggle Terminal act on the active window.
            let label = focused_window_label(app);
            let _ = app.emit_to(label.as_str(), "menu-action", id);
        })
```

- [ ] **Step 4: Drop window state when a window is destroyed**

In `src-tauri/src/lib.rs`, add an `.on_window_event(...)` call to the `tauri::Builder` chain (place it right after `.on_menu_event(...)`):

```rust
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let label = window.label().to_string();
                window.state::<AppState>().remove_window(&label);
            }
        })
```

`Emitter` (`emit_to`) and `Manager` (`webview_windows`, `state`) are used here — ensure `use tauri::{Emitter, Manager};` remains in `lib.rs` (it already imports both).

- [ ] **Step 5: Build the app**

Run: `cd src-tauri && cargo build`
Expected: PASS — compiles with no errors.

- [ ] **Step 6: Manual verification (GUI behavior can't be unit-tested)**

Run: `bun run tauri:dev`. Then:
1. Open the **File** menu → confirm **New Window** appears at the top with `⇧⌘N`.
2. Press `⇧⌘N` → a second window opens.
3. In window A open a git project (Open Folder), in window B open a *different* git project → each Source Control panel shows its own changes; staging in A does not alter B.
4. Focus window A and press `⌘S` → only window A saves (window B's editor is untouched).
5. Close window B → window A keeps working (terminal, git refresh still function).

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/menu.rs src-tauri/src/lib.rs
git commit -m "feat: New Window menu item + focused-window menu routing + window cleanup"
```

---

### Task 3: New windows open empty (frontend restore gate)

Restore the CLI launch path / last folder only in the primary window, so every New Window starts on the Welcome screen.

**Files:**
- Modify: `src/App.tsx` (import `getCurrentWindow`; gate the restore effect)

**Interfaces:**
- Consumes: the `main` label convention and the New Window created in Task 2.

- [ ] **Step 1: Import the window API**

In `src/App.tsx`, add near the other `@tauri-apps/api` imports:

```tsx
import { getCurrentWindow } from "@tauri-apps/api/window";
```

- [ ] **Step 2: Gate the restore effect on the primary window**

In `src/App.tsx`, the restore effect (~line 370) currently begins:

```tsx
  // Restore: CLI launch path first, then last opened folder.
  useEffect(() => {
    let cancelled = false;
    getLaunchPath()
```

Change it so non-primary windows return immediately:

```tsx
  // Restore the CLI launch path / last folder only in the primary window;
  // every New Window (label "w-N") starts empty on the Welcome screen.
  useEffect(() => {
    if (getCurrentWindow().label !== "main") return;
    let cancelled = false;
    getLaunchPath()
```

(Leave the rest of the effect body unchanged.)

- [ ] **Step 3: Type-check / build the frontend**

Run: `bun run build`
Expected: PASS — `tsc` + Vite build succeed with no type errors.

- [ ] **Step 4: Manual verification**

Run `bun run tauri:dev`, open a folder in the first window, then press `⇧⌘N`.
Expected: the new window shows the Welcome screen (no folder), while the first window keeps its project.

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx
git commit -m "feat: new windows open empty (restore only the primary window)"
```

---

### Task 4: Scope terminal output to its window

Emit pty output/exit events to the owning window instead of broadcasting. Terminals already work across windows (ids are globally unique), so this is a correctness/hygiene change with no user-visible difference.

**Files:**
- Modify: `src-tauri/src/pty.rs:52-125` (`pty_spawn` emits to its window)

**Interfaces:**
- Consumes: `tauri::WebviewWindow` injection. No frontend change — `invoke("pty_spawn", { cwd, cols, rows })` still passes no window.

- [ ] **Step 1: Add the window parameter and emit to it**

In `src-tauri/src/pty.rs`, change `pty_spawn`'s signature to add `window`:

```rust
#[tauri::command]
pub fn pty_spawn(
    cwd: String,
    cols: u16,
    rows: u16,
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<PtyState>,
) -> Result<u32, String> {
```

Replace the reader thread's clone/emit. Change:

```rust
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
```

to:

```rust
    let app_out = app.clone();
    let target = window.label().to_string();
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
                        let _ = app_out.emit_to(target.as_str(), &format!("pty-output-{id}"), text);
                    }
                }
            }
        }
        let _ = app_out.emit_to(target.as_str(), &format!("pty-exit-{id}"), ());
    });
```

(`app` is still used for the `_ = app;` — actually `app` is now only used to clone `app_out`; keep the `app: AppHandle` param since `app_out` needs it.)

- [ ] **Step 2: Build and run pty tests**

Run: `cd src-tauri && cargo test pty`
Expected: PASS — `pty_pair_runs_a_command_and_produces_output` passes; crate compiles.

- [ ] **Step 3: Manual verification**

Run `bun run tauri:dev`, open two windows, open a terminal in each, run `echo hi` in window A's terminal.
Expected: only window A's terminal shows the output; window B's terminal is unaffected.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/pty.rs
git commit -m "refactor: scope terminal pty events to their owning window"
```

---

## Self-Review

**Spec coverage:**
- Per-window git state → Task 1. ✓
- Per-window watcher, emit to owning window → Task 1 (Steps 4, 8). ✓
- Menu routed to focused window → Task 2 (Step 3). ✓
- New Window (`⇧⌘N`, empty) → Task 2 (Steps 1-3) + Task 3. ✓
- New windows match main config → Task 2 (Step 2). ✓
- Window cleanup on close → Task 2 (Step 4). ✓
- Terminals scoped to window → Task 4. ✓
- File ops unchanged (already stateless) → no task, per spec. ✓
- Closing last window quits / no close prompt → no code (Tauri default), per Global Constraints. ✓

**Type consistency:** `AppState`, `WindowState`, `AppState::window(&str) -> Arc<WindowState>`, `AppState::remove_window(&str)`, `watcher::start(&Path, AppHandle, String)`, `menu::open_new_window(&AppHandle<R>)`, and the `window: tauri::WebviewWindow` command parameter are used consistently across tasks. Window labels: `main` (primary) and `w-N` (new) match between `next_window_label`, the frontend gate, and `focused_window_label`'s fallback.

**Placeholder scan:** none — every code step shows complete code; GUI-only behavior uses explicit manual steps.
