# Changelog

All notable changes to Maincode are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/); dates are ISO 8601 and released
versions match the [GitHub releases](https://github.com/champ3oy/maincode/releases).
Each merged PR adds an entry under **Unreleased**; cutting a release moves those
entries under a new version heading.

## [Unreleased]

### Added
- Editor: **language intelligence for 14 languages** — real error squiggles, hover
  docs, completions, and ⌘-click go-to-definition now work for Python, Rust, Go,
  C/C++, Bash, YAML, JSON, HTML, CSS, Dockerfile, Svelte, GraphQL, and Vue (in
  addition to JS/TS) — each powered by its real language server (Pyright,
  rust-analyzer, gopls, clangd, …) speaking the Language Server Protocol.
- Settings: **Language Servers panel** — see every server and its state
  (Built-in / Installed / Missing), install the downloadable ones with live
  progress, or remove them. Rust prefers the rustup toolchain's rust-analyzer so
  it always matches your cargo; Go installs gopls via your Go toolchain; C/C++
  downloads clangd from its official release — all cached under
  `~/.config/maincode/servers`, so the app bundle stays small.
- Status bar: **live indexing progress** (e.g. "rust-analyzer: Indexing 45%")
  while a language server warms up. Opening a project that contains Rust
  pre-warms rust-analyzer in the background so it's often ready before you open
  a `.rs` file.
- Editor: hover cards render **markdown with syntax-highlighted code blocks**
  (signatures, `@example` fences, prose formatting).
- Editor: syntax highlighting for many more file types — TOML, `.env`, INI,
  shell, Dockerfile, XML, SQL, Java, Kotlin, C#, Swift, Ruby, Lua, diff, and
  more (including extension-less files like `Dockerfile` and dotfiles like
  `.bashrc`).
- Terminal: **tabs** — multiple terminals now live in a tab strip instead of
  split panes, and it works whether the terminal is docked at the bottom or the
  side. Switching tabs keeps each shell and its scrollback alive.
- **In-app auto-update** — a top-right indicator checks GitHub for new releases;
  when one is available, one click downloads it, installs it, and relaunches.
- Titlebar: **AI CLI launcher** — a dropdown lists the AI coding CLIs you have
  installed (Claude Code, OpenCode, Gemini, Aider, Codex, Cursor, Antigravity)
  and opens the one you pick in a new terminal tab.

### Changed
- The TypeScript engine moved from an in-app compiler worker to the real
  **typescript-language-server** — faster and markedly more accurate on
  monorepos, NestJS, Next.js, and React Native projects (no more phantom
  "cannot find module" squiggles). The "TypeScript Intelligence" setting is now
  **"Language Intelligence"** and governs all languages.

### Fixed
- Error tooltips near the top of the file flip below the line instead of
  clipping offscreen.
- Intelligence activates on the first opened file — previously diagnostics and
  hover stayed dead until you switched tabs and back.
- Installing a language server no longer freezes the app — installs run in the
  background with visible phase progress, and failures surface a readable error
  with a Retry button (e.g. "Go toolchain not found").
- Each window gets its own language-server sessions (no cross-window
  diagnostics bleed), and closing a window stops exactly its own servers.
- Rapidly switching projects while a language server was still starting no
  longer leaks the server process.
- Opening a different project now clears the previous project's editor tabs and
  terminal sessions instead of leaving them behind.
- Triggering **Open Folder** (menu / ⌘O) no longer pops the dialog in every
  open window — only the focused one.

## [0.1.2] — 2026-07-13

### Added
- Terminal: the toggle now **hides & restores** the terminal instead of closing
  it — running shells, scrollback, and splits survive across hide/show. Drag the
  divider to resize it, and dock it at the bottom or the right.
- Editor: **TypeScript intelligence** — semantic completions with **auto-import** (e.g. `useState` before it's imported), `obj.` member completions, real TypeScript error squiggles, **hover type info** in a rich Zed-style card (highlighted signature + JSDoc), and **go-to-definition** (⌘-click a symbol, with a ⌘-hover underline) for JS/TS projects — powered by the TypeScript compiler in a background worker, fully offline. Toggle in ⌘, → Editor.
- Editor: **Prettier formatting** — format the active file via ⇧⌥F, *Edit → Format Document*, or the
  command-center "Format Document" entry. Supported types: JS/JSX/MJS/CJS (Babel), TS/TSX/MTS/CTS
  (TypeScript), JSON/JSONC/JSON5, CSS/SCSS/LESS, HTML, Markdown, YAML. The ⇧⌥F path preserves the
  cursor position (single undo step); menu/palette paths apply the format as an editor change so
  undo works. Project-level config is picked up from `.prettierrc`, `.prettierrc.json`, or
  `package.json#prettier` (JSON-based only; JS/YAML config files are not read). Unsupported file
  types show a friendly info toast; syntax errors show a readable error toast. All Prettier modules
  are lazy-loaded on first use so the main bundle size is not affected.
- Settings: **Format on Save** toggle (Settings → Editor → "Format on Save") — runs Prettier
  before every ⌘S write; formatted content is written in a single file operation.
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
