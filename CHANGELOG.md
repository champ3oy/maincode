# Changelog

All notable changes to Maincode are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/); dates are ISO 8601 and released
versions match the [GitHub releases](https://github.com/champ3oy/maincode/releases).
Each merged PR adds an entry under **Unreleased**; cutting a release moves those
entries under a new version heading.

## [Unreleased]

### Added
- Editor: **autocomplete + linting** — language completions (JS snippets, HTML tags, etc.) plus
  document-word fallback (`completeAnyWord`) appear as you type; ⌃Space triggers manually.
  Syntax-error squiggles (Lezer parse tree) and a gutter marker appear for all languages; JSON
  files additionally get precise `jsonParseLinter()` diagnostics. Both features are toggleable
  independently in Settings → Editor ("Autocomplete" and "Linting"). No new dependencies — all
  from installed `@codemirror/*` packages.
- **Settings page** — ⌘, (or *Maincode → Settings…* / command-center "Open Settings") opens
  a Zed-style settings tab in the editor. Three categories: Appearance (theme), Editor (font
  size, font family, tab size, word wrap), and Terminal (font size). Changes apply live and
  persist to `settings.json`. An "Edit in settings.json" button opens the raw file. ⌘S on
  the Settings tab is a safe no-op.
- Editor: **image viewer** — opening an image file (png, jpg, jpeg, gif, svg,
  webp, bmp, ico, avif) now renders it read-only in the editor instead of the
  "Cannot open a binary file" toast. Images are displayed fit-to-view with a
  checkerboard backdrop and a footer showing filename and natural dimensions.
  Files larger than 25 MB show a friendly error rather than loading.
- Editor: **Find & Replace** redesigned as a VS Code-style floating widget in the
  top-right — match count, case / whole-word / regex toggles, prev/next, and an
  expandable replace row (⌘F find, ⌘⌥F replace, Esc to close).
- Editor: **font zoom** — ⌘= / ⌘- adjust the editor font size and ⌘0 resets it
  (also in the View menu); the chosen size persists across sessions.
- Native multi-window support — open multiple projects at once, each window fully
  independent (file tree, git, terminals). New Window via **File → New Window**
  (⇧⌘N) and the macOS **Dock menu**, which also lists open windows to switch
  between. Window titles show the open project.
  ([#1](https://github.com/champ3oy/maincode/pull/1))
- **Command Center** — replaces the ⌘P command palette with a Warp-style
  tabbed overlay (All / Files / Recent / Commands tabs, fuzzy filtering, icon
  rows, footer hints). Also fixes the ⌘P double-toggle bug: the keydown
  handler now handles only ⌘K; ⌘P is handled exclusively by the native menu
  accelerator.

### Fixed
- New windows were missing capabilities, so dragging, IPC, events, and dialogs
  were denied in them. ([#1](https://github.com/champ3oy/maincode/pull/1))

## [0.1.1] — 2026-07-12

### Fixed
- Integrated terminal now runs a **login shell**, so tools on your `PATH`
  (Homebrew binaries, `claude`, …) resolve instead of "command not found".

## [0.1.0] — 2026-07-12

### Added
- First release. Native macOS editor (Apple Silicon), signed & notarized:
  CodeMirror 6 editor, file tree with colored icons, tabs, find & replace,
  command palette, file/folder/content search, integrated terminal (multiple,
  splittable), VS Code-style source control, native menu bar, and a `main` CLI
  to open a folder from the terminal.
