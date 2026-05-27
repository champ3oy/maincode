# History Tab — Implementation Plan

Goal: add a second sidebar tab `History` next to the existing `Changes`, listing commits walking back from HEAD. Selecting a commit shows its diff in the existing diff panel, with a commit-info header above. Modeled after Zed's `git_panel` + `commit_view`.

## Scope

### In
- Two-tab sidebar (`Changes`, `History`). Branch Diff stays as a transient mode launched from the empty Changes view.
- History tab: virtualized commit list, walks all ancestors of HEAD on the current branch (full DAG, date order).
- Selecting a commit: diff vs **first parent** rendered in the existing `DiffPanel`, with a new commit-detail header slotted above the file stack.
- Read-only: no inline comments on history diffs.

### Out (explicit non-goals for v1)
Graph lines, ref pills, commit search/filter, tags view, branch picker inside History, ahead/behind counter, checkout/cherry-pick/revert/copy-permalink actions, blame integration, file-level history.

## UI

### Sidebar tabs
- Render **above** the existing sidebar header row (back-button + repo-name). Full-width pill tabs, each half.
- Visible in all sidebar modes (`working`, `branch`, `history`). In Branch Diff mode they show but are **disabled/grayed**; clicking exits Branch Diff and switches to that tab.
- `Changes` tab pill carries a small dot when uncommitted changes exist while user is on History (replaces the working-changes banner that branch-diff has).

### Commit list (Sidebar, History mode)
- TanStack Virtual scroller. Row payload from streamed metadata: `{oid, parent_oids, refs}`. Author/subject/date filled lazily.
- Row layout: avatar (left) + column[subject (line 1, truncate) / row(author_name • relative_time • short_sha) muted small].
- Default selection: HEAD auto-selected on first open of History tab (if nothing selected).
- Selection clears on: tab switch (Changes ↔ History), branch switch, repo close. Survives `repo:changed` if (branch, head_oid) unchanged.
- Keyboard: `↑/↓` move focus, `Enter`/`Space` open. Mirror Zed's minimal nav.
- Avatar: Gravatar `<img src=https://www.gravatar.com/avatar/<md5(email)>?d=404&s=80>`. Frontend `Map<md5, 'ok'|'missing'>` skips re-requests within a session. Fallback on `'missing'` or `onError`: initials circle (first letter of `author_name`, hsl color from md5).
- Empty / loading states:
  - Initial walk in flight: stream rows as they arrive + small `"N loaded"` counter at top until `done` event.
  - Empty repo / unborn HEAD: centered `"No commits yet"`.
  - Detached HEAD: walk from HEAD oid; show `(detached)` where the branch name would go.

### Commit detail (Diff panel, History mode)
Slotted above the existing file diff stack — does not replace `DiffPanel`, just adds a new header region.

- **Header row** (mirror Zed `commit_view.rs:559-654`):
  - LEFT: 40px avatar + column[`author_name` (default) / row(`date_string` muted small • `•` alpha-0.5 • `author_email` muted small)]. Date format `MediumAbsolute` (e.g. "Apr 16, 2026").
  - RIGHT: `Commit SHA` button + copy icon (turns ✓ when SHA already in clipboard).
- **Commit message** below header, before file diffs:
  - Subject bold (one line).
  - Body in a monospace block.
  - Auto-expand if body ≤ 8 lines; "Show more" disclosure otherwise.
- File diffs: reuse existing `DiffPanel` rendering (`@pierre/diffs` CodeView, split/unified toggle, expand-all). Comment gutter suppressed in history mode (add `readOnly` prop to `DiffPanel` rather than forking the component).

## Backend (Rust / git2)

Five new Tauri commands.

### `list_commits_stream(branch: Option<String>, request_id: String) -> { request_id, total_estimate: Option<u64> }`
- Starts a background walker thread; returns immediately.
- Walker: `Revwalk` from HEAD with `Sort::TIME` (DateOrder). Full DAG (both parents of merges, dedup by oid). No --first-parent on the walk itself; first-parent only applies to the **diff** of a merge commit.
- Builds an `oid -> Vec<ref_name>` map once at start (enumerate refs).
- Emits chunks of `GRAPH_CHUNK_SIZE = 1000` via `commit-history:chunk { request_id, oids: [{oid, parents, refs}] }`.
- Emits `commit-history:done { request_id }` on completion (or `commit-history:error { request_id, message }`).
- Cancellation: `AppState.walker_generation: AtomicU64` increments on each call; `walker_cancel: AtomicBool` set on new walk or repo close. Walker checks cancel between chunks, exits early. Frontend ignores any chunk whose `request_id` doesn't match the active one.

### `get_commit_details_batch(oids: Vec<String>) -> Vec<CommitDetails>`
```rust
struct CommitDetails {
    oid: String,
    subject: String,              // first line of message
    body: String,                 // remainder (may be empty)
    author_name: String,
    author_email: String,
    author_timestamp: i64,        // seconds since epoch
    committer_name: String,
    committer_email: String,
    committer_timestamp: i64,
}
```
- Parallel git2 lookups using `std::thread::scope` (mirror `get_branch_file_contents_batch`).

### `get_commit_diff(oid: String) -> { parent_oid: Option<String>, files: Vec<FileEntry> }`
- For merges: `parent_oid = commit.parent(0).id()` (first parent).
- For root commit: `parent_oid = None`.
- Diff = `diff_tree_to_tree(parent_tree, commit_tree)`; reuses `count_diff_lines_parallel` for per-file +/-.

### `get_root_commit_file_contents_batch(oid: String, requests: Vec<String>) -> Vec<FileContentsBatchItem>`
- Parallel structure identical to `get_branch_file_contents_batch`, but `old_content = None` / `old_binary = false` for every entry (root commit has no parent). All files render as additions.

### `get_head_state() -> { branch: Option<String>, head_oid: String }`
- Cheap probe used by the frontend to gate history cache invalidation on `repo:changed`.

## Frontend wiring

### Hook: `useCommitHistory(active: boolean, workdir: string | null)`
- Cache `Map<{branch, head_oid}, Oid[]>` (latest cache only; LRU not needed at this granularity).
- On `active && workdir`: call `get_head_state()`. If `(branch, head_oid)` matches cache, reuse `oids` array. Otherwise:
  - Mint `request_id = crypto.randomUUID()`.
  - Call `list_commits_stream({ branch, request_id })`.
  - Listen for `commit-history:chunk` / `done` / `error`; append to `oids` and bump `loadedCount` when `request_id` matches; ignore others.
- On `repo:changed` (gated by active && tab === history && hook is mounted): re-probe `get_head_state()`; if changed, re-walk.
- Return `{ oids: Oid[], decorations: Map<oid, RowMetadata>, loaded: number, done: boolean, error?: string }`.

### Hook: `useCommitDetailsCache()`
- Session-wide `Map<oid, CommitDetails>` (no eviction in v1; bound is total commits walked which is already bounded by user attention).
- `requestVisible(oids: Oid[])`: dedupe against cache, debounce 50ms, then fire `get_commit_details_batch` with the dedup'd set.
- TanStack Virtual `onChange` callback computes visible oids ± 50 prefetch each side, hands to `requestVisible`.
- Returns `(oid) => CommitDetails | 'pending'`.

### Hook: `useCommitDiff(oid: string | null)`
- On `oid` change: call `get_commit_diff(oid)`; then either `get_branch_file_contents_batch({ baseOid: parent_oid, headOid: oid, requests: paths })` or `get_root_commit_file_contents_batch({ oid, requests: paths })` based on `parent_oid` presence.
- Returns shape compatible with existing `DiffPanel` props (`files`, `diffs`).

### Sidebar mode wiring (App.tsx)
- Add `tab: 'changes' | 'history'` state next to existing `branchDiffActive`.
- Sidebar resolution table:

  | tab        | branchDiffActive | sidebar mode |
  |------------|-------------------|--------------|
  | changes    | false             | `working`    |
  | changes    | true              | `branch`     |
  | history    | false             | `history`    |
  | history    | true              | `branch` (tabs grayed) |

- Selecting `history` while `branchDiffActive` keeps Branch Diff visible but with tabs grayed; explicit tab click required to exit Branch Diff (per "tabs_in_branch_diff" decision).
- Diff panel resolution:
  - `working`: existing `diffs` + `allFiles` + commenting.
  - `branch`: existing `branchDiff.{files,diffs}` + branch info.
  - `history`: `useCommitDiff` output + commit-detail header + `readOnly`.

### `DiffPanel` modifications
- Add `readOnly?: boolean` and `commitDetailHeader?: ReactNode` props.
- `readOnly` suppresses the comment gutter, comment forms, and review-submit affordances. Existing comment props become optional in that mode.
- `commitDetailHeader` renders above the file stack (peer of the existing `branchInfo`/`workingChangesNotice` banners).

## Concurrency / invariants

- Only one active walker per `AppState` at a time. New `list_commits_stream` call bumps `walker_generation`, signals cancel, joins the previous handle (or detaches if held only by the thread itself).
- Frontend never trusts events: every chunk carries `request_id` and is dropped on mismatch.
- Cache invalidation: `(branch, head_oid)` is the only cache key. Branch switch ⇒ different branch. Commit/checkout ⇒ different head_oid. Pure fs noise (file edits, mtime touches) ⇒ key unchanged ⇒ no-op.

## Implementation order
1. **Backend**: `get_head_state` → `get_commit_details_batch` → `get_commit_diff` → `get_root_commit_file_contents_batch` → `list_commits_stream` (last because of the cancellation/event plumbing).
2. **Frontend hooks**: `useCommitHistory` → `useCommitDetailsCache` → `useCommitDiff`.
3. **Frontend components**: `SidebarTabs`, `SidebarHistory` (commit list + virtualization), `CommitDetailHeader`. Add `readOnly` + `commitDetailHeader` to `DiffPanel`.
4. **App wiring**: extend the sidebar/diff-panel resolution table in `App.tsx`.
5. **Verification**: typecheck + vite build, manual exercise on a large repo (e.g. zed itself, ~50k commits) for streaming/virtualization, and on a fresh `git init` (empty), root commit, and detached HEAD.

## Risks / open questions
- **DiffPanel comment-prop fan-out**: `DiffPanel` currently treats comment props as required. The `readOnly` flag needs an audit pass to make every comment prop optional and gated on `!readOnly`. Mechanical but touches several lines.
- **Walker pause on file activity**: emitting 1000-oid chunks for a 100k repo while the user types may cause noticeable IPC pressure. If perceived sluggish, throttle chunk emission (e.g. 50ms gap between chunks) — easy follow-up, not v1 blocker.
- **Gravatar latency on first scroll**: 100+ parallel image requests on first paint. Browser will pool but may stall paint. If noticed, add a request-throttle in the avatar component (e.g. only fetch for rows in the viewport, not the prefetch window).
