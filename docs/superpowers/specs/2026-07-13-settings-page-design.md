# Settings Page — Design

**Goal:** A proper Zed-style settings page for Maincode, backed by a real
`settings.json` config file on disk, opened as a tab in the editor.

## Config file

- Location: `~/.config/maincode/settings.json` (created with defaults on first
  read; missing/partial files are merged over the defaults).
- Schema (all keys optional; defaults applied):
  ```json
  {
    "theme": "system",                    // "light" | "dark" | "system"
    "editor":   { "fontSize": 13, "fontFamily": "app-mono", "tabSize": 2, "wordWrap": false },
    "terminal": { "fontSize": 12 },
    "diff":     { "fontSize": 13, "wordWrap": false }
  }
  ```
  `fontFamily` ∈ `"app-mono" | "system-mono" | "courier"` (reuse the existing
  `FontChoice`). Font sizes clamp to sane ranges (editor/diff 8–32, terminal 8–24).

## Backend (Rust, `settings.rs`)

- `read_settings() -> String` — read the file (create `~/.config/maincode/` and
  a defaults file if absent), return its raw JSON text.
- `write_settings(json: String) -> Result<(), String>` — atomically write the
  file (create parent dir if needed).
- `settings_path() -> String` — absolute path, for "Edit in settings.json".
- Home dir via `std::env::var("HOME")`. Unit test: read on a fresh temp HOME
  returns valid defaults JSON; write then read round-trips.

## Settings store (`SettingsProvider` context)

- On mount: `read_settings()` → parse → **deep-merge over defaults** → typed
  `Settings` object. Malformed JSON falls back to defaults (never crash).
- Exposes `settings` (typed) and `set(path, value)` — updates in-memory state,
  applies live, and **debounced-writes** the merged object back via
  `write_settings`.
- **External edits:** re-read `settings.json` when it changes. Reuse the file
  watcher if practical, else re-read on window focus. Applying external edits
  keeps the UI and the app in sync.
- This provider is the **single source of truth**, replacing `use-editor-font`
  and `use-diff-settings` and the ad-hoc theme wiring.

## Consumers (migration)

- **Theme:** `settings.theme` drives next-themes (`setTheme`); the settings
  page's theme control and any command both go through `set("theme", …)`.
- **Editor:** `code-editor.tsx` reads `settings.editor.fontSize` /
  `.fontFamily` (font compartment), `.tabSize` (`EditorState.tabSize` /
  indent unit), `.wordWrap` (`EditorView.lineWrapping`). The ⌘=/⌘- font-zoom
  and the View-menu items call `set("editor.fontSize", …)`.
- **Terminal:** `terminal-panel.tsx` uses `settings.terminal.fontSize` (was
  hardcoded 12); updates apply to the xterm instance.
- **Source control:** `diff-panel.tsx` reads `settings.diff.fontSize` /
  `.wordWrap` (replacing `use-diff-settings`).

## Settings tab (UI)

- Opens as a special **`Settings` tab** in the editor area (same mechanism as
  the image tab — branch in `editor-area.tsx` on a settings pseudo-path, e.g.
  `maincode://settings`). Read-only to `saveFile` (guarded like image tabs).
- Layout (Zed): left column = search box + category list
  (**Appearance · Editor · Terminal · Source Control**); right column = the
  active category's rows, each with a **label**, **description**, and a
  **control** (dropdown / number stepper / toggle). Top-right **"Edit in
  settings.json"** opens the file as a normal editor tab (`openFile(settings_path)`).
- All controls read/write through the settings store, so changes persist to
  `settings.json` and apply live.

## Opening

- **⌘,** (Cmd+Comma), an app-menu **Settings…** item (via the existing
  `menu.rs` + `menu-action` path), and a **command-center** entry ("Open
  Settings").

## Out of scope (v1)

- Keymap editor, per-language settings, project-level settings, JSON schema
  validation/autocomplete in the editor, and the many Zed categories Maincode
  has no settings for. The store + file are structured so more settings can be
  added later without rework.

## Testing

- Rust: `read_settings`/`write_settings` round-trip + defaults-on-missing.
- Frontend: build clean; manual — change each control → the app updates live and
  `settings.json` reflects it; edit `settings.json` externally → the app picks it
  up; ⌘S on the settings tab does nothing.
