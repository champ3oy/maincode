# Editor & Window UX Batch — Design Spec

**Date:** 2026-07-14
**Status:** Design — pending user review before planning.

## Goal

Five independent editor/window improvements to maincode (Tauri v2 + React/TS + CodeMirror 6):

1. **Terminal tabs** — replace the split-panes terminal with tabs (works docked bottom or right).
2. **In-app auto-update** — check GitHub releases, show a top-right indicator, download+install+relaunch.
3. **Project-switch reset (bug)** — opening a new folder must clear the previous project's editor tabs and terminal sessions.
4. **Open-folder dialog double-fire (bug)** — triggering "open folder" in one window opens the dialog in every window.
5. **AI CLI launcher** — an AI-icon dropdown of installed AI coding CLIs; picking one opens it in a terminal tab.

**These five are independent** and may be implemented and shipped in any order, with two couplings noted below. Feature 2 is the largest (plugin + signing + release-process change) and could be split into its own cycle; it is kept here for a single review pass.

## Coupling & ordering

- **Feature 5 depends on Feature 1**: the AI launcher opens a new terminal *tab* and needs a "new terminal running a command" path, which is cleanest to build on the tab model. Sequence **1 → 5**.
- All others are independent.

## Global constraints

- No new heavyweight deps beyond what each feature strictly needs. Feature 2 adds `tauri-plugin-updater`, `tauri-plugin-process`, and their JS counterparts; Feature 5 adds no deps.
- Reuse existing patterns: shadcn UI primitives (`DropdownMenu`, `Popover`, `Button`), `@tabler/icons-react`, the `menu-action` event bus, `invoke`.
- macOS-first (Apple Silicon), matching current release targets.
- Preserve current behavior not explicitly changed (dock toggle, resize, hide/restore, per-window sessions).

---

## Feature 1 — Terminal tabs (replace splits)

### Current state
`terminal-dock.tsx` renders N terminals as split panes in a `ResizablePanelGroup` (orientation from dock position). State: `const [terminals, setTerminals] = useState<number[]>([0])` + a `nextId` ref. Each `TerminalPanel` owns its PTY (`pty_spawn` on mount, cleanup kills it).

### Target
A **tab strip + a single visible terminal**. Tabs replace splits entirely (the `ResizableHandle` between terminals and the per-terminal `ResizablePanelGroup` are removed).

- **State:** `terminals: { id: number; title: string }[]` and `activeId: number`. `title` defaults to the shell basename (e.g. `zsh`) or `zsh 2` when duplicated; an AI-launched tab (Feature 5) titles itself after the CLI (e.g. `claude`).
- **Mounting:** ALL terminals stay mounted; inactive ones are hidden with `display:none` (a `hidden` class), never unmounted — so the running shell, scrollback, and xterm state survive tab switches. Only the active tab is visible.
- **Refit on activate:** when a hidden terminal becomes active, it must refit xterm to the now-visible size (xterm can't measure a `display:none` element). `TerminalPanel` exposes/observes an "is active" prop and calls its `FitAddon.fit()` + `pty_resize` when it transitions to active (and on container resize while active).
- **Tab strip (`terminal-tabs.tsx`):** a horizontal row of tab chips + a `+` button, rendered at the **top of the dock in both positions** (docked bottom: full-width row above the terminal; docked right: a row at the top of the narrow column, horizontally scrollable when tabs overflow). Each chip: title + close `✕` (hover/active), click to activate. The dock's existing header (New-terminal `+`, dock-toggle, close) is reconciled with the strip: the `+` moves into/next to the strip; dock-toggle and hide stay in the dock header.
- **Behaviors:** `+` adds a tab and activates it. Closing a tab kills its PTY (existing unmount cleanup, now triggered by removing it from the list) and, if it was active, activates the nearest neighbor. Closing the last tab either leaves an empty dock or hides the dock — match current "close last terminal" behavior (verify during implementation; default: hide the dock, consistent with the hide/restore feature).

### Components / files
- `terminal-tabs.tsx` (new) — the strip.
- `terminal-dock.tsx` — tabs state, active tracking, render active + hide inactive, wire the strip.
- `terminal-panel.tsx` — accept `active: boolean`, refit on becoming active + on resize while active; keep PTY lifecycle.

### Data flow
Dock owns `terminals` + `activeId`. Passes `active={id === activeId}` to each panel. Strip calls `onActivate(id)`, `onClose(id)`, `onAdd()`.

### Testing
- Unit (vitest + RTL): adding tabs appends & activates; closing the active tab activates a neighbor; closing last hides the dock; inactive panels render with the `hidden` class (stay mounted). Mock `invoke` for PTY calls.
- Manual: split→tabs visual in both dock positions; scrollback survives switching; refit correct after switching and after resizing the dock.

---

## Feature 2 — In-app auto-update (GitHub releases)

### Approach
`tauri-plugin-updater` with a static update manifest hosted on GitHub Releases; a titlebar indicator drives check → download → install → relaunch.

### Rust / config
- Add `tauri-plugin-updater` and `tauri-plugin-process` (Cargo.toml) and register both in `lib.rs`.
- `tauri.conf.json`:
  - `bundle.createUpdaterArtifacts: true` (produces the signed `.app.tar.gz` + `.sig` at build).
  - `plugins.updater`:
    ```json
    {
      "endpoints": ["https://github.com/champ3oy/maincode/releases/latest/download/latest.json"],
      "pubkey": "<UPDATER_PUBLIC_KEY>"
    }
    ```
- Capabilities: grant the updater + process permissions to the main window(s) in the capability file.

### Signing key (user-owned; kept out of the assistant's context)
- The **user** runs `npm run tauri signer generate -- -w ~/.tauri/maincode.key` once, stores the private key + password securely (password manager), and provides only the **public key** to embed in `tauri.conf.json`.
- Release builds export `TAURI_SIGNING_PRIVATE_KEY` (+ `..._PASSWORD`) so `tauri build` signs the artifact.

### Release process (manual — no CI today)
Documented in the repo (e.g. `docs/RELEASING.md`):
1. Bump version in `tauri.conf.json` + `Cargo.toml` + `package.json`.
2. `TAURI_SIGNING_PRIVATE_KEY=… TAURI_SIGNING_PRIVATE_KEY_PASSWORD=… npm run tauri build` → yields the `.app.tar.gz` + `.sig` (and the existing `.dmg`).
3. Create the GitHub release; upload the `.dmg`, the `.app.tar.gz`, and a hand-or-script-assembled **`latest.json`**:
   ```json
   {
     "version": "0.1.3",
     "notes": "…",
     "pub_date": "2026-…T…Z",
     "platforms": {
       "darwin-aarch64": { "signature": "<contents of .sig>", "url": "https://github.com/champ3oy/maincode/releases/download/v0.1.3/maincode.app.tar.gz" }
     }
   }
   ```
   A small `scripts/make-latest-json.mjs` assembles this from the build output to avoid hand-editing.

### Frontend
- Add `@tauri-apps/plugin-updater` + `@tauri-apps/plugin-process`.
- A `use-update-check` hook: on app start and every 6h, call `check()`. Result state: `idle | available(update) | downloading(progress) | error`. Checks that throw are swallowed to `idle` (offline, rate-limited, etc.) — never surface a scary error for a background check.
- Titlebar indicator (`update-indicator.tsx`) mounted in the top-right button group (see Feature 5 for the shared region): hidden when `idle`; when `available`, an "Update available" pill/dot. Click → `Popover` with target version + notes + **Update & Restart**. That runs `downloadAndInstall(onProgress)` (pill shows a progress bar) then `relaunch()`. Download errors → toast + keep the pill.
- Only the focused/primary window need show it; a per-window hook instance is fine (each checks independently; that's acceptable — GitHub caches the manifest).

### Constraint (documented in-app notes + RELEASING.md)
The updater only updates **from** a build that already includes it. Current 0.1.2 has no updater; the first updater-enabled release (0.1.3) must be installed manually. 0.1.3 → later is automatic.

### Testing
- Unit: `use-update-check` state machine with a mocked `check`/`downloadAndInstall` (available → downloading(progress) → relaunch called; check-throws → idle). Indicator renders pill only when available; popover triggers install.
- Manual/integration: real end-to-end update requires two signed builds; verified out-of-band at release time (documented checklist).

---

## Feature 3 — Reset editor tabs + terminals on project switch (bug)

### Root cause
Nothing resets on `rootPath` change. `use-workspace`'s `openFolder(path)` only sets `rootPath` + localStorage; editor tabs (`use-editor` reducer state) and the terminal dock persist, and terminals keep the old cwd.

### Fix
On a genuine `rootPath` change (not initial mount, not same-path re-open):
- **Editor:** dispatch a `closeAll`/`reset` action to the tabs reducer. Preserve existing unsaved-file handling — reuse whatever the current single-tab close does for dirty tabs (confirm during implementation; if there is no guard today, closing all is acceptable and matches current close behavior, but note it).
- **Terminals:** **key `<TerminalDock rootPath>` on `rootPath`** in `App.tsx` so the whole dock unmounts on switch — every `TerminalPanel`'s cleanup fires (kills its PTY) — and a fresh dock mounts at the new cwd (starting with one terminal, or empty per current default).

### Files
- `App.tsx` — `key={rootPath}` on `TerminalDock`; an effect (or reducer wiring) that resets editor tabs when `rootPath` transitions.
- `use-editor` reducer — a `closeAll`/`reset` action if none exists.

### Testing
- Unit: reducer `reset` clears tabs; effect fires reset on `rootPath` change and NOT on initial mount / same-path.
- Manual: open project A, open files + terminals; open project B → tabs empty, terminals fresh at B's cwd; PTYs for A are killed (no orphan processes).

---

## Feature 4 — Open-folder dialog double-fires across windows (bug)

### Symptom
With two windows, triggering "open folder" (menu / ⌘O) in one window opens the dialog in **both**.

### Investigation (systematic-debugging — root cause unconfirmed)
The menu path *looks* window-scoped: `lib.rs` `on_menu_event` emits `menu-action` via `emit_to(focused_window_label, …)`. The observed behavior contradicts the code, so implementation begins by confirming the actual cause:
- Log, per window, receipt of the `menu-action` "open-folder" event (which windows fire).
- Inspect `focused_window_label` with two windows open at menu-trigger time — does `is_focused()` return true for one, none (→ fallback "main"), or more than one? Does clicking a menu item transiently unfocus both?
- Confirm whether `emit_to(label, …)` actually filters, or whether both App instances' `listen("menu-action")` receive it.

### Likely fix (final form decided after the repro)
Make the open-folder action act only in the originating/focused window. Candidate fixes, chosen by what the repro shows:
- Guard the App `menu-action` handler: for window-scoped actions, ignore unless `getCurrentWindow().isFocused()`; **or**
- Fix `focused_window_label` to resolve the correct single window (e.g. track last-focused window rather than relying on `is_focused()` at menu time); **or**
- Route open-folder through a window-targeted command instead of a broadcast-y menu emit.

### Files
- `lib.rs` (focus resolution / emit), `App.tsx` (`menu-action` listener guard).

### Testing
- Manual (two windows): ⌘O in window A opens exactly one dialog, in A only. Repeat with B focused. Regression-check single-window ⌘O and the status-bar/welcome open paths (those are direct calls, must be unaffected).
- If the fix lands in `focused_window_label`, add a Rust unit test for the focus-resolution helper if it's made pure/testable.

---

## Feature 5 — AI CLI launcher dropdown (detect installed)

### UI
An **AI icon button** in the titlebar top-right, **after** the terminal icon (`title-bar.tsx` button group). Click → `DropdownMenu` listing the **installed** AI CLIs, each a row (icon + label). Empty state row: "No AI CLIs found on your PATH." Picking one opens a **new terminal tab** (Feature 1) that runs the CLI.

### Detection (Rust)
`list_ai_clis() -> Vec<AiCli>` where `AiCli { id, label, bin }`:
- Candidate set (id / label / bin):
  - `claude` / "Claude Code" / `claude`
  - `opencode` / "OpenCode" / `opencode`
  - `gemini` / "Gemini CLI" / `gemini`
  - `aider` / "Aider" / `aider`
  - `codex` / "Codex" / `codex`
  - `agy` / "Antigravity" / `agy`
- Resolution: take the login-shell PATH (reuse the cached login-PATH helper), split on `:`, and for each candidate return it iff some `PATH_ENTRY/bin` is an existing executable file. This finds Homebrew / npm-global / `~/.local/bin` installs even when launched from Finder. No per-candidate subprocess.
- Command registered in `lib.rs`. New module `ai.rs` (or a small section of an existing module).

### Launch (frontend + terminal)
- The dropdown calls a new dock API: **`openTerminalWithCommand(cmd, title)`** — adds a terminal tab, and once its PTY is spawned and ready, sends `${cmd}\n` via `pty_write` (the CLI runs inside a normal interactive login shell; on exit the user is back at a prompt). Tab title = the CLI label.
- "Ready" = after `pty_spawn` resolves and the initial shell prompt has had a tick; send on the next frame / a short delay, or after the first data event. Keep it simple and robust (a small delay after spawn is acceptable; document the choice).
- The dock must be visible when launching (un-hide if hidden).

### Files
- `ai.rs` (new) + `lib.rs` register.
- `ai-launcher.tsx` (new titlebar dropdown) — calls `list_ai_clis`, renders the menu, invokes the dock launch API.
- `terminal-dock.tsx` — expose `openTerminalWithCommand` (built on the tab model); a shared handle/context or a prop callback from `App.tsx`.
- `title-bar.tsx` — mount the AI button after the terminal button.

### Testing
- Unit (Rust): `list_ai_clis` given a fake PATH with a subset of the bins present returns exactly those (pure function over a PATH string + a dir-probe seam).
- Unit (RTL): dropdown renders returned CLIs; empty state; clicking a row calls the launch API with the right command. Mock `invoke`.
- Manual: pick Claude Code → a terminal tab opens titled "claude" running `claude`; an uninstalled CLI simply isn't listed.

---

## Cross-cutting testing & rollout

- Each feature is independently testable and shippable. Suggested order: **3 (bug) → 4 (bug) → 1 (tabs) → 5 (AI launcher, builds on 1) → 2 (auto-update)**, so the quick wins land first and the heavy infra feature is last.
- Existing suites (cargo `--lib`, vitest unit) must stay green; new unit tests per feature as above.
- Auto-update and the two-window bug have manual verification steps that can't be fully unit-tested; those are called out per feature.

## Open risks / notes

- **F2 signing key handling**: the private key never passes through the assistant; the user generates it and shares only the pubkey. Losing the private key means future updates can't be signed (would require shipping a new pubkey → another manual install). Documented in RELEASING.md.
- **F2 version floor**: unavoidable manual install of the first updater-enabled build.
- **F4 root cause is unconfirmed**; the fix's final shape is decided after the live repro. If the repro shows the dialog double-fire comes from a path other than the menu emit (e.g. a global listener), the fix moves accordingly — the spec's investigation step governs.
- **F1 last-tab behavior** and **F3 dirty-file-on-switch** each inherit current behavior; both are flagged to confirm against the existing code during implementation rather than inventing new UX.
