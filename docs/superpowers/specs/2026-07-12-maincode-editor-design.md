# Maincode — Design

**Date:** 2026-07-12
**Status:** Approved (design), pending spec review

## Summary

Build **Maincode**, a simple desktop code editor, by transforming the cloned
[cub.dev](https://github.com/ephraimduncan/cub.dev) repository in place
("Approach A"). Cub is a Tauri v2 + React 19 + Vite + Tailwind v4 desktop git
client. We keep its shell, UI kit, theming, and git plumbing; strip the AI
code-review / MCP layer; and grow editor features on top using CodeMirror 6 and
an integrated terminal.

## Goals

- A native desktop code editor: open a folder, browse a file tree, edit and save
  files with syntax highlighting.
- Familiar quality-of-life features: tabs, file operations, find & replace, a
  command palette, and an integrated terminal.
- A VS Code-style **Source Control** panel reusing cub's existing git backend:
  view changes, diff, stage/unstage, discard, commit, switch branches.

## Non-Goals

- AI code review and the MCP sidecar (cub's signature feature) — removed.
- Extensions/plugins, remote/SSH editing, multi-window, settings sync.
- Advanced IDE features (LSP/IntelliSense, debugging, refactoring).
- Windows/Intel-mac support beyond whatever cub already provides (cub targets
  Apple Silicon; we inherit its constraints).

## Decisions (locked during brainstorming)

| Decision | Choice |
|---|---|
| Platform | Desktop — keep Tauri v2 (requires Rust + Bun to build) |
| Base strategy | Approach A: transform cub.dev in place |
| Editor engine | CodeMirror 6 (wired directly, no wrapper lib) |
| App name | **Maincode** |
| Git scope | VS Code-style Source Control panel (no AI review / MCP) |
| State management | React context + hooks (matches cub; no Redux) |

## Architecture

Three layers, all inside the existing Tauri app.

```
┌─────────────────────────────────────────────────────────┐
│  React 19 + Vite + Tailwind v4  (frontend, the window)   │
│                                                          │
│  Sidebar tabs: [ Files ] [ Source Control ]              │
│  ┌──────────┬────────────────────────────────────────┐  │
│  │ Files    │  Tab bar (open files + dirty dot)       │  │
│  │  → tree  ├────────────────────────────────────────┤  │
│  │ Source   │  CodeMirror 6 editor  OR  diff view     │  │
│  │ Control  ├────────────────────────────────────────┤  │
│  │  → chgs  │  Terminal (xterm.js) — collapsible      │  │
│  └──────────┴────────────────────────────────────────┘  │
│  Status bar: branch · cursor · language · unsaved count  │
│  Command palette (cmdk, Cmd+K / Cmd+Shift+P overlay)     │
└───────────────────────────┬──────────────────────────────┘
                            │  Tauri invoke() (req/resp)
                            │  Tauri events (streaming)
┌───────────────────────────┴──────────────────────────────┐
│  Rust backend (src-tauri/src)                             │
│   • fs.rs   — read_dir, read_file, write_file,            │
│               create/rename/delete                        │
│   • git.rs  — status, diff, stage, unstage, discard,      │
│               commit, branch list/switch  (kept from cub) │
│   • pty.rs  — spawn/write/resize/kill (portable-pty),     │
│               output streamed via pty://output/{id}       │
└───────────────────────────────────────────────────────────┘
```

- **Request/response** (file ops, git ops) via Tauri `invoke()`.
- **Streaming** (terminal output) via Tauri **events**.
- Folder picker uses `@tauri-apps/plugin-dialog` (already a dependency).

## Backend (Rust — `src-tauri/src/`)

Three command groups, registered in `lib.rs`.

### `fs.rs` (new) — file operations
- `read_dir(path)` → `[{ name, path, is_dir }]`. Lazy: children loaded on expand.
- `read_file(path)` → contents. Guards large/binary files (returns a flag rather
  than dumping large payloads across the bridge).
- `write_file(path, contents)` — save.
- `create_file(path)`, `create_dir(path)`, `rename_path(from, to)`,
  `delete_path(path)`.

### `git.rs` (kept from cub, trimmed)
Reuse cub's git plumbing for: repo status (staged / unstaged / untracked),
per-file diff, stage, unstage, discard, commit, current branch + branch
list/switch. Remove only the review-specific entry points that fed the MCP
bridge.

### `pty.rs` (new) — integrated terminal
- `pty_spawn(cwd, cols, rows)` → id, `pty_write(id, data)`, `pty_resize(id, cols,
  rows)`, `pty_kill(id)`.
- Output streamed to the frontend via Tauri events (`pty://output/{id}`).
- PTY handles kept in a `Mutex<HashMap<Id, PtyHandle>>` app state.
- Uses the `portable-pty` crate.

### Removed from backend
`review_bridge.rs`, the entire `sidecar/` MCP server, `.mcp.json`, the `mcp:*`
npm scripts, and the `@modelcontextprotocol/sdk` + `better-sqlite3` deps.

## Frontend (`src/`)

State: React context + hooks (matching cub).
- `WorkspaceContext` — root folder path, file-tree data, recent folders
  (persisted to localStorage).
- `EditorContext` — open tabs `[{ path, name, content, dirty, cmState }]`, active
  tab id, save/close actions.
- Git state — reuse cub's `use-repo-status` / `use-diffs` hooks, stripped of
  comment logic.
- Theme — cub's existing `next-themes` setup, unchanged.

Layout (reusing `react-resizable-panels`):
- **Sidebar** (left, tabbed via cub's `sidebar-tabs`):
  - *Files* → new `file-tree/` component. Recursive tree, expand/collapse,
    click-to-open, right-click context menu (create/rename/delete) built on
    cub's `ui/context-menu.tsx`.
  - *Source Control* → repurposed from cub's git sidebar: changed-files list
    grouped staged/unstaged/untracked; stage/unstage/discard; commit bar (reuse
    `commit-bar.tsx`).
- **Center** → `editor-area/`: a tab bar over the active view, which is **either**
  the CodeMirror editor **or** cub's repurposed `diff-panel` (when a change is
  selected in Source Control).
- **Bottom** → `terminal/` panel (xterm.js + `@xterm/addon-fit`), collapsible,
  wired to `pty://output` events.
- **Status bar** (repurpose cub's) → branch name + switcher, cursor line/col,
  language, unsaved count.
- **Command palette** → `command-palette/` overlay on cub's bundled `cmdk`
  (Cmd+K / Cmd+Shift+P): open file, save, toggle terminal, switch theme, git
  commit, etc.

### CodeMirror 6 wiring
`@codemirror/state` + `@codemirror/view` + `@codemirror/commands` +
`@codemirror/search` (find & replace) + language packs
(`lang-javascript` / `python` / `html` / `css` / `json` / `markdown` / `rust` /
…) selected by file extension, plus a dark theme (`@codemirror/theme-one-dark`)
toggled with the app theme. Wired directly (small, explicit) rather than via a
wrapper library.

### Removed from frontend
`components/comments/`, review-submission wiring in `diff-panel`,
`types/comments.ts`, `use-comments`, and the review dialogs in `onboarding/`
(replaced by an "open a folder" welcome screen). Commit history (`commit-detail/`
+ History tab) is optional and can land later. Unused shadcn `ui/*` components
stay (harmless, no runtime cost).

## Dependencies

- **Add (frontend):** CodeMirror packages (state/view/commands/search + language
  packs + theme), `@xterm/xterm`, `@xterm/addon-fit`.
- **Add (Rust):** `portable-pty`.
- **Remove:** `@modelcontextprotocol/sdk`, `better-sqlite3`, and any deps tied
  solely to removed features.
- **Keep:** `@pierre/diffs` + `@pierre/trees` (diff rendering, still used by the
  Source Control diff view), `cmdk`, `react-resizable-panels`, the shadcn/base-ui
  kit, `next-themes`, `@tauri-apps/plugin-dialog`.

## Rename (Cub → Maincode)

Update: `package.json` `name`, `src-tauri/tauri.conf.json` `productName` /
`identifier` / window title, `Cargo.toml` package name, README/CONTEXT, and the
window title in the app shell. Drop cub-specific distribution: `Casks/`,
homebrew references, and cub's release workflow. Icons: keep cub's for now,
replace later.

## Testing

- **Rust:** unit tests for `fs.rs` (read_dir / read / write / rename / delete on a
  temp dir) and a `pty.rs` smoke test (spawn `echo`, assert an output event).
  Keep cub's existing git tests.
- **Frontend:** Vitest for pure logic — language-detection-by-extension,
  tab/dirty reducers, path helpers. Component/integration tests are lower-value
  inside a Tauri shell; core UI verified manually via `tauri dev`.
- TDD the pure-logic modules first where practical.

## Build phases (become the implementation plan)

1. **Strip & rename** → clean, running Tauri shell titled "Maincode", empty
   editor layout.
2. **FS backend + file tree** → open a folder, browse, open a file read-only in
   CodeMirror.
3. **Editing** → edit, save, dirty tracking, tabs.
4. **Highlighting + find/replace** → language detection, CM search.
5. **File operations** → create/rename/delete + context menu.
6. **Source Control** → wire cub's git backend to the repurposed changes panel +
   diff view + commit.
7. **Command palette.**
8. **Integrated terminal** (heaviest — PTY + xterm) lands here.
9. **Polish** → recent folders, status bar, theme sync, keybindings.

## Prerequisites / environment

- Install **Rust** (rustup) and **Bun** before building — neither is currently
  installed. Node 22, npm, pnpm, and Xcode CLT are present; machine is Apple
  Silicon (arm64).
- Open question: whether to keep cub's git history or reinitialize git for a
  fresh Maincode history. To be decided before the first commit.

## Risks / open questions

- **Terminal (PTY)** is the most complex piece; `portable-pty` behavior on
  Apple Silicon + Tauri event streaming needs a small spike. Scoped last so the
  core editor is usable without it.
- **Large/binary files** — `read_file` must guard against loading huge or binary
  blobs into CodeMirror.
- **Git history** — keep cub's or start fresh (see prerequisites).
