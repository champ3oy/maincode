# Changelog

All notable changes to Maincode are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/); dates are ISO 8601 and released
versions match the [GitHub releases](https://github.com/champ3oy/maincode/releases).
Each merged PR adds an entry under **Unreleased**; cutting a release moves those
entries under a new version heading.

## [Unreleased]

### Added
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
