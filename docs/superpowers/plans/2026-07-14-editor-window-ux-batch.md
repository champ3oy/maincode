# Editor & Window UX Batch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship five independent editor/window improvements: project-switch reset, open-folder dialog fix, terminal tabs, an AI-CLI launcher, and in-app auto-update.

**Architecture:** Frontend is React + TS (Vite, vitest + Testing Library). Backend is Rust (Tauri v2). Terminal uses xterm.js via `TerminalPanel`; editor tabs via a reducer (`editor-tabs-reducer.ts`); menu actions arrive over a `menu-action` Tauri event; PTYs via `pty_*` commands. Auto-update adds `tauri-plugin-updater` + `tauri-plugin-process`.

**Tech Stack:** Tauri v2, React 18, TypeScript, xterm.js (`@xterm/xterm`, `@xterm/addon-fit`), shadcn UI (`DropdownMenu`, `Popover`, `Button`), `@tabler/icons-react`, vitest, `tauri-plugin-updater`.

## Global Constraints

- Design spec: `docs/superpowers/specs/2026-07-14-editor-window-ux-batch-design.md`.
- Order: Feature 3 → 4 → 1 → 5 → 2 (bugs first; AI launcher builds on tabs; auto-update last). Task numbers below follow this order.
- Tabs **replace** splits entirely; inactive terminals stay **mounted but `display:none`** (shell + scrollback survive).
- AI CLI candidates (id / label / bin): `claude`/"Claude Code"/`claude`, `opencode`/"OpenCode"/`opencode`, `gemini`/"Gemini CLI"/`gemini`, `aider`/"Aider"/`aider`, `codex`/"Codex"/`codex`, `agy`/"Antigravity"/`agy`.
- Auto-update endpoint: `https://github.com/champ3oy/maincode/releases/latest/download/latest.json`. The updater private key is **user-generated and never handled by the assistant** — only the public key is embedded.
- Version floor: auto-update only works from a build that already ships it (documented, not code).
- Every existing suite stays green: `cd src-tauri && cargo test --lib` and `npx vitest run` (unit; integration files excluded where noted).

---

## Feature 3 — Project-switch reset (bug)

### Task 1: `reset` action on the tabs reducer + `closeAllTabs` in the editor context

**Files:**
- Modify: `src/hooks/editor-tabs-reducer.ts`
- Modify: `src/hooks/use-editor.tsx`
- Test: `src/hooks/editor-tabs-reducer.test.ts` (create)

**Interfaces:**
- Produces: reducer action `{ type: "reset" }` → `initialTabsState`; context method `closeAllTabs(): void`.

- [ ] **Step 1: Write the failing test**

Create `src/hooks/editor-tabs-reducer.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { tabsReducer, initialTabsState, type TabsState } from "./editor-tabs-reducer";

describe("tabsReducer reset", () => {
  it("clears all tabs and the active path", () => {
    const populated: TabsState = {
      tabs: [
        { path: "/a.ts", name: "a.ts", content: "x", savedContent: "x" },
        { path: "/b.ts", name: "b.ts", content: "y", savedContent: "z" },
      ],
      activePath: "/b.ts",
    };
    expect(tabsReducer(populated, { type: "reset" })).toEqual(initialTabsState);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `npx vitest run src/hooks/editor-tabs-reducer.test.ts`
Expected: FAIL (the `"reset"` action isn't in the `TabsAction` union / not handled).

- [ ] **Step 3: Add the action + case**

In `src/hooks/editor-tabs-reducer.ts`, extend the union (after the `renamePath` member on line 19):
```ts
  | { type: "renamePath"; from: string; to: string; name: string }
  | { type: "reset" };
```
Add a case inside `tabsReducer`'s `switch` (before `default`/closing brace):
```ts
    case "reset":
      return initialTabsState;
```

- [ ] **Step 4: Run it — expect PASS**

Run: `npx vitest run src/hooks/editor-tabs-reducer.test.ts` → PASS.

- [ ] **Step 5: Expose `closeAllTabs` from the editor context**

In `src/hooks/use-editor.tsx`:
- Add to the `EditorContextValue` interface (near `closeTab: (path: string) => void;` around line 33): `closeAllTabs: () => void;`
- Add the callback (near `closeTab`, ~line 179):
```ts
  const closeAllTabs = useCallback(() => {
    dispatch({ type: "reset" });
  }, []);
```
- Add `closeAllTabs` to BOTH the returned `value` object and the `useMemo` dependency array (alongside `closeTab`).

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck 2>&1 | grep -E "use-editor|editor-tabs" || echo clean`
```bash
git add src/hooks/editor-tabs-reducer.ts src/hooks/editor-tabs-reducer.test.ts src/hooks/use-editor.tsx
git commit -m "feat(editor): reset action + closeAllTabs for project switch"
```

---

### Task 2: Reset editor tabs + terminals when the project changes

**Files:**
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `closeAllTabs` (Task 1); `rootPath` (`useWorkspace`); `<TerminalDock>`.

- [ ] **Step 1: Reset editor tabs on a real `rootPath` change**

In `src/App.tsx`, pull `closeAllTabs` from `useEditor()` (add it to the destructure around line 78). Add an effect (place it near the other `rootPath` effects, ~line 92):
```tsx
  // Opening a different project must not carry the previous project's tabs.
  // Skip the initial mount (nothing to clear) and same-path re-selection.
  const prevRootRef = useRef<string | null>(null);
  useEffect(() => {
    if (prevRootRef.current !== null && prevRootRef.current !== rootPath) {
      closeAllTabs();
    }
    prevRootRef.current = rootPath;
  }, [rootPath, closeAllTabs]);
```
(`useRef` is already imported in App.tsx.)

- [ ] **Step 2: Reset terminals by keying the dock on the project root**

Find the `<TerminalDock` usage in `src/App.tsx` (around line 900–920, inside the `!showTerminal && "hidden"` panel). Add a `key` so a project switch unmounts every `TerminalPanel` (each cleanup kills its PTY) and a fresh dock mounts at the new cwd:
```tsx
                <TerminalDock
                  key={rootPath ?? "no-project"}
                  cwd={rootPath ?? "~"}
                  ...existing props...
                />
```
Keep all existing props (`cwd`, `position`, `onTogglePosition`, `onEmpty`) exactly as they are; only add `key`.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck 2>&1 | grep -E "App.tsx" || echo clean` → clean.

- [ ] **Step 4: Manual verification**

Run `npm run tauri:dev`. Open project A; open two files and two terminals (`cd` somewhere in one). Open project B via ⌘O.
Expected: editor shows no tabs; the terminal dock is fresh (one terminal) at B's path; `ps` shows the old shells were killed (no orphan PTYs).

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx
git commit -m "fix: reset editor tabs + terminals when switching projects"
```

---

## Feature 4 — Open-folder dialog fires on every window (bug)

### Task 3: Route menu actions to the last-focused window only

**Root cause:** `focused_window_label` (`lib.rs`) queries `is_focused()` at menu-event time, but invoking a macOS app-menu item transfers key focus to the menu bar, so `is_focused()` can be false for every window → the `.find` misses and it falls back to `"main"`, misrouting (and, combined with how a plain JS `listen` receives the event, surfacing in the wrong/every window). Fix deterministically: track the last window that actually had focus, emit the action with an explicit target label, and have each window act only on its own.

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/App.tsx`

**Interfaces:**
- Produces: `menu-action` payload changes from a bare `string` to `{ action: string; target: string }`.

- [ ] **Step 1: Track the last-focused window (Rust)**

In `src-tauri/src/lib.rs`, add a process-wide last-focused label near the top (after the existing `LAUNCH_PATH` static ~line 17):
```rust
static LAST_FOCUSED: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);
```
In `on_window_event` (the closure with `WindowEvent::Destroyed`), add a `Focused` arm so focus gained updates the tracker:
```rust
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Focused(true) = event {
                if let Ok(mut lf) = LAST_FOCUSED.lock() {
                    *lf = Some(window.label().to_string());
                }
            }
            if let tauri::WindowEvent::Destroyed = event {
                // ...existing Destroyed body unchanged...
            }
        })
```

- [ ] **Step 2: Emit the action to the tracked window with an explicit target**

Replace `focused_window_label` (lines 31–37) so it prefers the tracked label and only falls back to a live query:
```rust
/// The label of the window that most recently held focus. Menu items are invoked
/// from the app menu bar (which steals key focus), so a live `is_focused()` query
/// at event time is unreliable — we track focus-gained instead.
fn focused_window_label(app: &tauri::AppHandle) -> String {
    if let Ok(lf) = LAST_FOCUSED.lock() {
        if let Some(label) = lf.clone() {
            return label;
        }
    }
    app.webview_windows()
        .into_iter()
        .find(|(_, w)| w.is_focused().unwrap_or(false))
        .map(|(label, _)| label)
        .unwrap_or_else(|| "main".to_string())
}
```
In `on_menu_event`, change the emit (currently `app.emit_to(label.as_str(), "menu-action", id)`) to a **global** emit carrying the target, so the delivery no longer depends on `emit_to` filtering:
```rust
            let label = focused_window_label(app);
            let _ = app.emit("menu-action", serde_json::json!({ "action": id, "target": label }));
```
(`serde_json` is already a dependency; `Emitter`/`emit` is already imported via `use tauri::{Emitter, Manager};`.)

- [ ] **Step 3: Build (Rust)**

Run: `cd src-tauri && cargo build 2>&1 | tail -3` → clean, 0 warnings.

- [ ] **Step 4: Frontend — parse the new payload, act only if it targets this window**

In `src/App.tsx`, import the current window label helper at the top with the other imports:
```ts
import { getCurrentWindow } from "@tauri-apps/api/window";
```
Change the `menu-action` listener (lines 454–467) to parse `{action,target}` and filter by this window's label:
```tsx
  useEffect(() => {
    const myLabel = getCurrentWindow().label;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    listen<{ action: string; target: string }>("menu-action", (e) => {
      if (e.payload.target !== myLabel) return; // not addressed to this window
      void menuActionRef.current(e.payload.action);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
```
`onMenuAction` itself is unchanged (still takes the action string).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck 2>&1 | grep -E "App.tsx" || echo clean` → clean.

- [ ] **Step 6: Manual verification (two windows)**

`npm run tauri:dev`; open a second window (⇧⌘N). Focus window A, press ⌘O.
Expected: exactly one folder dialog, on window A. Repeat focusing window B → dialog only on B. Confirm ⌘S / New File still act on the focused window only, and the status-bar "Open Local" + welcome "Open Folder" buttons (direct calls) still work.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/lib.rs src/App.tsx
git commit -m "fix: route menu actions to the last-focused window (no cross-window dialogs)"
```

---

## Feature 1 — Terminal tabs (replace splits)

### Task 4: Terminal tab strip component

**Files:**
- Create: `src/components/terminal/terminal-tabs.tsx`
- Test: `src/components/terminal/terminal-tabs.test.tsx` (create)

**Interfaces:**
- Produces: `TerminalTab = { id: number; title: string }`; `<TerminalTabs tabs activeId onActivate onClose onAdd />`.

- [ ] **Step 1: Write the failing test**

Create `src/components/terminal/terminal-tabs.test.tsx`:
```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TerminalTabs } from "./terminal-tabs";

const tabs = [{ id: 0, title: "zsh" }, { id: 1, title: "claude" }];

describe("TerminalTabs", () => {
  it("renders a chip per tab and marks the active one", () => {
    render(<TerminalTabs tabs={tabs} activeId={1} onActivate={() => {}} onClose={() => {}} onAdd={() => {}} />);
    expect(screen.getByText("zsh")).toBeTruthy();
    expect(screen.getByRole("tab", { name: /claude/ }).getAttribute("aria-selected")).toBe("true");
  });
  it("calls onActivate / onClose / onAdd", () => {
    const onActivate = vi.fn(), onClose = vi.fn(), onAdd = vi.fn();
    render(<TerminalTabs tabs={tabs} activeId={0} onActivate={onActivate} onClose={onClose} onAdd={onAdd} />);
    fireEvent.click(screen.getByRole("tab", { name: /claude/ }));
    expect(onActivate).toHaveBeenCalledWith(1);
    fireEvent.click(screen.getByLabelText("Close zsh"));
    expect(onClose).toHaveBeenCalledWith(0);
    fireEvent.click(screen.getByLabelText("New terminal"));
    expect(onAdd).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `npx vitest run src/components/terminal/terminal-tabs.test.tsx` → FAIL (module missing).

- [ ] **Step 3: Implement the strip**

Create `src/components/terminal/terminal-tabs.tsx`:
```tsx
import { IconPlus, IconX } from "@tabler/icons-react";
import { cn } from "@/lib/utils";

export interface TerminalTab {
  id: number;
  title: string;
}

interface TerminalTabsProps {
  tabs: TerminalTab[];
  activeId: number;
  onActivate: (id: number) => void;
  onClose: (id: number) => void;
  onAdd: () => void;
}

// Horizontal tab strip for the terminal dock. Renders the same in both dock
// positions (it lives at the top of the dock); scrolls horizontally on overflow.
export function TerminalTabs({ tabs, activeId, onActivate, onClose, onAdd }: TerminalTabsProps) {
  return (
    <div className="flex min-w-0 items-center gap-0.5 overflow-x-auto">
      {tabs.map((t) => {
        const active = t.id === activeId;
        return (
          <div
            key={t.id}
            role="tab"
            aria-selected={active}
            aria-label={t.title}
            tabIndex={0}
            onClick={() => onActivate(t.id)}
            className={cn(
              "group flex shrink-0 cursor-pointer items-center gap-1.5 rounded px-2 py-0.5 text-xs",
              active ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-muted/40",
            )}
          >
            <span className="max-w-32 truncate">{t.title}</span>
            <button
              type="button"
              aria-label={`Close ${t.title}`}
              onClick={(e) => { e.stopPropagation(); onClose(t.id); }}
              className="flex size-4 items-center justify-center rounded opacity-0 hover:bg-muted group-hover:opacity-100"
            >
              <IconX className="size-3" />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        aria-label="New terminal"
        title="New terminal"
        onClick={onAdd}
        className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <IconPlus className="size-3.5" />
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `npx vitest run src/components/terminal/terminal-tabs.test.tsx` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/terminal/terminal-tabs.tsx src/components/terminal/terminal-tabs.test.tsx
git commit -m "feat(terminal): tab strip component"
```

---

### Task 5: Convert the dock from splits to tabs; refit inactive panels on activation

**Files:**
- Modify: `src/components/terminal/terminal-dock.tsx`
- Modify: `src/components/terminal/terminal-panel.tsx`
- Test: `src/components/terminal/terminal-dock.test.tsx` (create)

**Interfaces:**
- Consumes: `TerminalTabs`, `TerminalTab` (Task 4).
- Produces: `TerminalDock` gains an imperative `openTerminalWithCommand(command: string, title: string)` via a `ref` (used by Feature 5). Signature: `useImperativeHandle` exposing `{ openTerminalWithCommand(command: string, title: string): void }`. `TerminalPanel` gains props `active: boolean` and optional `command?: string`.

- [ ] **Step 1: Write the failing test (dock tab management)**

Create `src/components/terminal/terminal-dock.test.tsx`. Mock `TerminalPanel` so the test is about tab logic, not xterm:
```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TerminalDock } from "./terminal-dock";

vi.mock("./terminal-panel", () => ({
  TerminalPanel: ({ active }: { active: boolean }) => (
    <div data-testid="panel" data-active={active} />
  ),
}));

describe("TerminalDock tabs", () => {
  it("starts with one active terminal; + adds and activates a new one", () => {
    render(<TerminalDock cwd="/x" position="bottom" onTogglePosition={() => {}} onEmpty={() => {}} />);
    expect(screen.getAllByTestId("panel")).toHaveLength(1);
    fireEvent.click(screen.getByLabelText("New terminal"));
    const panels = screen.getAllByTestId("panel");
    expect(panels).toHaveLength(2);
    // exactly one active
    expect(panels.filter((p) => p.getAttribute("data-active") === "true")).toHaveLength(1);
  });
  it("closing the last terminal calls onEmpty", () => {
    const onEmpty = vi.fn();
    render(<TerminalDock cwd="/x" position="bottom" onTogglePosition={() => {}} onEmpty={onEmpty} />);
    fireEvent.click(screen.getByLabelText(/Close/));
    expect(onEmpty).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `npx vitest run src/components/terminal/terminal-dock.test.tsx` → FAIL (dock still split-based; no "New terminal" in strip / labels differ).

- [ ] **Step 3: Rewrite `terminal-dock.tsx` to tabs**

Replace the body of `src/components/terminal/terminal-dock.tsx` with a tabbed dock. Keep the `TerminalPosition` export, the `cwd`/`position`/`onTogglePosition`/`onEmpty` props, the dock header (position toggle stays), and add the strip. Render every panel, hiding inactive ones with `hidden`:
```tsx
import { forwardRef, useCallback, useImperativeHandle, useRef, useState } from "react";
import { IconLayoutBottombar, IconLayoutSidebarRight } from "@tabler/icons-react";
import { TerminalPanel } from "./terminal-panel";
import { TerminalTabs, type TerminalTab } from "./terminal-tabs";

export type TerminalPosition = "bottom" | "right";

export interface TerminalDockHandle {
  openTerminalWithCommand: (command: string, title: string) => void;
}

interface TerminalDockProps {
  cwd: string;
  position: TerminalPosition;
  onTogglePosition: () => void;
  onEmpty: () => void;
}

interface TermEntry extends TerminalTab {
  command?: string;
}

// Hosts terminals as tabs. All panels stay mounted; inactive ones are hidden
// (display:none) so their shell + scrollback survive tab switches.
export const TerminalDock = forwardRef<TerminalDockHandle, TerminalDockProps>(function TerminalDock(
  { cwd, position, onTogglePosition, onEmpty },
  ref,
) {
  const nextId = useRef(1);
  const [terminals, setTerminals] = useState<TermEntry[]>([{ id: 0, title: "zsh" }]);
  const [activeId, setActiveId] = useState(0);

  const addTerminal = useCallback((command?: string, title = "zsh") => {
    const id = nextId.current++;
    setTerminals((prev) => [...prev, { id, title, command }]);
    setActiveId(id);
  }, []);

  useImperativeHandle(ref, () => ({
    openTerminalWithCommand: (command: string, title: string) => addTerminal(command, title),
  }), [addTerminal]);

  const closeTerminal = useCallback((id: number) => {
    setTerminals((prev) => {
      const next = prev.filter((t) => t.id !== id);
      if (next.length === 0) onEmpty();
      else {
        setActiveId((cur) => (cur === id ? next[next.length - 1].id : cur));
      }
      return next;
    });
  }, [onEmpty]);

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-2">
        <TerminalTabs
          tabs={terminals}
          activeId={activeId}
          onActivate={setActiveId}
          onClose={closeTerminal}
          onAdd={() => addTerminal()}
        />
        <button
          type="button"
          title={position === "bottom" ? "Move terminal to the side" : "Move terminal to the bottom"}
          onClick={onTogglePosition}
          className="ml-auto flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {position === "bottom" ? <IconLayoutSidebarRight className="size-3.5" /> : <IconLayoutBottombar className="size-3.5" />}
        </button>
      </div>
      <div className="relative min-h-0 flex-1">
        {terminals.map((t) => (
          <div key={t.id} className={t.id === activeId ? "absolute inset-0" : "hidden"}>
            <TerminalPanel cwd={cwd} active={t.id === activeId} command={t.command} />
          </div>
        ))}
      </div>
    </div>
  );
});
```

- [ ] **Step 4: Update `terminal-panel.tsx` — `active` + `command`, refit on activation**

In `src/components/terminal/terminal-panel.tsx`:
- Extend props:
```tsx
interface TerminalPanelProps {
  cwd: string;
  active: boolean;
  command?: string;
}
export function TerminalPanel({ cwd, active, command }: TerminalPanelProps) {
```
- After a successful `pty_spawn` (inside the `.then`, once `id`/refs are set, before the `.catch`), if a `command` was given, send it once the shell is up:
```tsx
        id = ptyId;
        ptyIdRef.current = ptyId;
        unlistenOut = unOut;
        unlistenExit = unExit;
        if (command) {
          // Let the login shell print its prompt, then run the command.
          setTimeout(() => { void invoke("pty_write", { id: ptyId, data: `${command}\n` }); }, 300);
        }
```
- Add an effect that refits when the panel becomes active (xterm can't measure while `display:none`):
```tsx
  // Refit when this tab becomes visible (xterm can't measure a hidden element).
  useEffect(() => {
    if (!active) return;
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    fit.fit();
    const ptyId = ptyIdRef.current;
    if (ptyId !== null) void invoke("pty_resize", { id: ptyId, cols: term.cols, rows: term.rows });
  }, [active]);
```
Leave the main setup effect keyed on `[cwd]` (do NOT add `active`/`command` — they must not re-spawn the PTY).

- [ ] **Step 5: Run tests — expect PASS**

Run: `npx vitest run src/components/terminal/terminal-dock.test.tsx src/components/terminal/terminal-tabs.test.tsx` → PASS.
Run: `npm run typecheck 2>&1 | grep -E "terminal" || echo clean` → clean.

- [ ] **Step 6: Update App.tsx dock usage for the new ref + drop obsolete props**

In `src/App.tsx`, the `<TerminalDock key={rootPath ?? "no-project"} ... />` now needs a ref for Feature 5. Add:
```tsx
  const terminalDockRef = useRef<TerminalDockHandle | null>(null);
```
and pass `ref={terminalDockRef}` to `<TerminalDock>`. Import the handle type:
```ts
import { TerminalDock, type TerminalDockHandle } from "@/components/terminal/terminal-dock";
```
No other dock props change.

- [ ] **Step 7: Manual verification**

`npm run tauri:dev`: multiple terminals now appear as tabs (bottom AND right dock). Switching tabs preserves scrollback; running `top` in tab 1, switching away and back, shows it still running and correctly sized. Closing the last tab hides the dock.

- [ ] **Step 8: Commit**

```bash
git add src/components/terminal/terminal-dock.tsx src/components/terminal/terminal-panel.tsx src/components/terminal/terminal-dock.test.tsx src/App.tsx
git commit -m "feat(terminal): tabs replace split panes; refit on activate; command-launch hook"
```

---

## Feature 5 — AI CLI launcher

### Task 6: Rust `list_ai_clis` — detect installed CLIs on the login PATH

**Files:**
- Create: `src-tauri/src/ai.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Produces: command `list_ai_clis() -> Vec<AiCli>` where `AiCli { id: String, label: String, bin: String }` (serde-serialized to `{ id, label, bin }`).

- [ ] **Step 1: Write the failing test (pure detection over a fake PATH)**

Create `src-tauri/src/ai.rs` with the detection split into a pure helper + a test:
```rust
use serde::Serialize;

#[derive(Serialize, Clone)]
pub struct AiCli {
    pub id: String,
    pub label: String,
    pub bin: String,
}

const CANDIDATES: &[(&str, &str, &str)] = &[
    ("claude", "Claude Code", "claude"),
    ("opencode", "OpenCode", "opencode"),
    ("gemini", "Gemini CLI", "gemini"),
    ("aider", "Aider", "aider"),
    ("codex", "Codex", "codex"),
    ("agy", "Antigravity", "agy"),
];

/// Pure: keep candidates whose `bin` exists in one of the PATH entries,
/// per the provided `exists` probe (so tests don't touch the filesystem).
fn detect(path: &str, exists: &dyn Fn(&std::path::Path) -> bool) -> Vec<AiCli> {
    let entries: Vec<&str> = path.split(':').filter(|s| !s.is_empty()).collect();
    CANDIDATES
        .iter()
        .filter(|(_, _, bin)| entries.iter().any(|dir| exists(&std::path::Path::new(dir).join(bin))))
        .map(|(id, label, bin)| AiCli { id: id.to_string(), label: label.to_string(), bin: bin.to_string() })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn detects_only_present_bins() {
        let present = ["/opt/homebrew/bin/claude", "/usr/local/bin/agy"];
        let exists = |p: &std::path::Path| present.contains(&p.to_string_lossy().as_ref());
        let got = detect("/opt/homebrew/bin:/usr/local/bin", &exists);
        let ids: Vec<&str> = got.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, vec!["claude", "agy"]);
    }
}
```

- [ ] **Step 2: Run it — expect FAIL**

Add `mod ai;` to `src-tauri/src/lib.rs` (with the other `mod` lines at the top), then run:
`cd src-tauri && cargo test --lib ai 2>&1 | tail -5`
Expected: FAIL to compile until `mod ai;` is added; then the test compiles and passes — if it fails, fix `detect`.

- [ ] **Step 3: Add the command wrapper using the real login PATH**

Append to `src-tauri/src/ai.rs`:
```rust
/// List AI coding CLIs found on the user's login-shell PATH. Reuses the LSP
/// module's cached login PATH so Homebrew / npm-global / ~/.local/bin installs
/// resolve even when the app was launched from Finder.
#[tauri::command]
pub fn list_ai_clis() -> Vec<AiCli> {
    let path = crate::lsp::login_path().unwrap_or_else(|| std::env::var("PATH").unwrap_or_default());
    detect(&path, &|p| p.is_file())
}
```
In `src-tauri/src/lsp.rs`, make `login_path` reachable from `ai.rs` by changing its signature to `pub fn login_path()` (it is currently private `fn login_path()`).

- [ ] **Step 4: Register the command**

In `src-tauri/src/lib.rs` `generate_handler!`, add `ai::list_ai_clis,` next to the other commands.

- [ ] **Step 5: Build + test**

Run: `cd src-tauri && cargo build 2>&1 | tail -3` → clean; `cargo test --lib 2>&1 | tail -3` → all pass (incl. the new `ai` test).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/ai.rs src-tauri/src/lib.rs src-tauri/src/lsp.rs
git commit -m "feat(ai): list_ai_clis — detect installed AI CLIs on the login PATH"
```

---

### Task 7: AI launcher dropdown in the titlebar

**Files:**
- Create: `src/components/titlebar/ai-launcher.tsx`
- Modify: `src/components/titlebar/title-bar.tsx`
- Modify: `src/App.tsx`
- Test: `src/components/titlebar/ai-launcher.test.tsx` (create)

**Interfaces:**
- Consumes: `list_ai_clis` (Task 6); `TerminalDockHandle.openTerminalWithCommand` (Task 5).
- Produces: `<AiLauncher onLaunch={(cli) => void} />`.

- [ ] **Step 1: Write the failing test**

Create `src/components/titlebar/ai-launcher.test.tsx`:
```tsx
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AiLauncher } from "./ai-launcher";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";

beforeEach(() => vi.mocked(invoke).mockReset());

describe("AiLauncher", () => {
  it("lists detected CLIs and launches the picked one", async () => {
    vi.mocked(invoke).mockResolvedValue([
      { id: "claude", label: "Claude Code", bin: "claude" },
      { id: "agy", label: "Antigravity", bin: "agy" },
    ]);
    const onLaunch = vi.fn();
    render(<AiLauncher onLaunch={onLaunch} />);
    fireEvent.click(screen.getByLabelText("AI CLIs"));
    await waitFor(() => screen.getByText("Claude Code"));
    fireEvent.click(screen.getByText("Antigravity"));
    expect(onLaunch).toHaveBeenCalledWith({ id: "agy", label: "Antigravity", bin: "agy" });
  });

  it("shows an empty state when none are installed", async () => {
    vi.mocked(invoke).mockResolvedValue([]);
    render(<AiLauncher onLaunch={() => {}} />);
    fireEvent.click(screen.getByLabelText("AI CLIs"));
    await waitFor(() => screen.getByText(/No AI CLIs found/));
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `npx vitest run src/components/titlebar/ai-launcher.test.tsx` → FAIL (module missing).

- [ ] **Step 3: Implement the dropdown**

Create `src/components/titlebar/ai-launcher.tsx` (use the existing `DropdownMenu` primitives — confirm exact exported names in `src/components/ui/dropdown-menu.tsx`; the standard shadcn set is `DropdownMenu`, `DropdownMenuTrigger`, `DropdownMenuContent`, `DropdownMenuItem`):
```tsx
import { useState } from "react";
import { IconSparkles } from "@tabler/icons-react";
import { invoke } from "@tauri-apps/api/core";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from "@/components/ui/dropdown-menu";

export interface AiCli { id: string; label: string; bin: string }

export function AiLauncher({ onLaunch }: { onLaunch: (cli: AiCli) => void }) {
  const [clis, setClis] = useState<AiCli[] | null>(null);
  const load = () => void invoke<AiCli[]>("list_ai_clis").then(setClis).catch(() => setClis([]));
  return (
    <DropdownMenu onOpenChange={(open) => { if (open) load(); }}>
      <DropdownMenuTrigger
        aria-label="AI CLIs"
        title="AI CLIs"
        className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
      >
        <IconSparkles className="size-4" stroke={1.75} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        {clis == null ? (
          <DropdownMenuItem disabled>Loading…</DropdownMenuItem>
        ) : clis.length === 0 ? (
          <DropdownMenuItem disabled>No AI CLIs found on your PATH</DropdownMenuItem>
        ) : (
          clis.map((c) => (
            <DropdownMenuItem key={c.id} onSelect={() => onLaunch(c)}>{c.label}</DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```
(If the project's `DropdownMenuItem` uses `onClick` rather than `onSelect`, use whichever it exports — verify in `dropdown-menu.tsx`.)

- [ ] **Step 4: Run it — expect PASS**

Run: `npx vitest run src/components/titlebar/ai-launcher.test.tsx` → PASS.

- [ ] **Step 5: Mount in the titlebar after the terminal button**

In `src/components/titlebar/title-bar.tsx`:
- Add to `TitleBarProps`: `onLaunchAiCli: (cli: { id: string; label: string; bin: string }) => void;`
- Import: `import { AiLauncher } from "./ai-launcher";`
- After the Terminal `TabButton` (after line 56, before `</div>`), add:
```tsx
        <AiLauncher onLaunch={onLaunchAiCli} />
```

- [ ] **Step 6: Wire the launch in App.tsx**

In `src/App.tsx`, where `<TitleBar ... />` is rendered (~line 752), pass:
```tsx
            onLaunchAiCli={(cli) => {
              setShowTerminal(true);
              terminalDockRef.current?.openTerminalWithCommand(cli.bin, cli.label);
            }}
```
(`setShowTerminal` and `terminalDockRef` already exist.)

- [ ] **Step 7: Typecheck + manual**

Run: `npm run typecheck 2>&1 | grep -E "ai-launcher|title-bar|App.tsx" || echo clean` → clean.
Manual (`tauri:dev`): the sparkles icon sits after the terminal icon; clicking lists your installed CLIs; picking one opens the terminal and a new tab titled after the CLI running its command.

- [ ] **Step 8: Commit**

```bash
git add src/components/titlebar/ai-launcher.tsx src/components/titlebar/ai-launcher.test.tsx src/components/titlebar/title-bar.tsx src/App.tsx
git commit -m "feat(ai): titlebar AI CLI launcher — opens the picked CLI in a terminal tab"
```

---

## Feature 2 — In-app auto-update

### Task 8: Add the updater + process plugins and configuration

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/capabilities/default.json` (or the project's capability file — locate it under `src-tauri/capabilities/`)
- Modify: `package.json`

**Interfaces:**
- Produces: updater + process plugins registered; JS `@tauri-apps/plugin-updater` + `@tauri-apps/plugin-process` available; `plugins.updater.endpoints`/`pubkey` set.

- [ ] **Step 1: User generates the signing keypair (manual, one-time)**

Ask the human partner to run (in their terminal, so the private key never enters the assistant's context):
```
npm run tauri signer generate -- -w ~/.tauri/maincode.key
```
They store `~/.tauri/maincode.key` (private) + its password securely, and provide **only** the printed **public key** string for Step 4. Do not proceed to Step 4 without it.

- [ ] **Step 2: Add Rust plugins**

In `src-tauri/Cargo.toml` dependencies:
```toml
tauri-plugin-updater = "2"
tauri-plugin-process = "2"
```
In `src-tauri/src/lib.rs`, register them in the builder chain (next to the other `.plugin(...)` calls):
```rust
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
```

- [ ] **Step 3: Add JS plugins**

```bash
npm install @tauri-apps/plugin-updater @tauri-apps/plugin-process
```

- [ ] **Step 4: Configure the updater + updater artifacts**

In `src-tauri/tauri.conf.json`:
- Under `bundle`, add: `"createUpdaterArtifacts": true`.
- Add a top-level `plugins` block (or extend it):
```json
  "plugins": {
    "updater": {
      "endpoints": ["https://github.com/champ3oy/maincode/releases/latest/download/latest.json"],
      "pubkey": "<PASTE_PUBLIC_KEY_FROM_STEP_1>"
    }
  }
```

- [ ] **Step 5: Grant capabilities**

In the window capability file under `src-tauri/capabilities/` (e.g. `default.json`), add to `permissions`:
```json
    "updater:default",
    "process:allow-restart"
```

- [ ] **Step 6: Build**

Run: `cd src-tauri && cargo build 2>&1 | tail -3` → clean (plugins compile, config valid).

- [ ] **Step 7: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/lib.rs src-tauri/tauri.conf.json src-tauri/capabilities package.json package-lock.json
git commit -m "build(update): add tauri updater + process plugins and config"
```

---

### Task 9: `use-update-check` hook

**Files:**
- Create: `src/hooks/use-update-check.ts`
- Test: `src/hooks/use-update-check.test.ts` (create)

**Interfaces:**
- Produces: `useUpdateCheck(): { status: "idle"|"available"|"downloading"|"error"; version?: string; notes?: string; progress?: number; install: () => void }`.

- [ ] **Step 1: Write the failing test**

Create `src/hooks/use-update-check.test.ts`:
```ts
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { useUpdateCheck } from "./use-update-check";

beforeEach(() => { vi.mocked(check).mockReset(); vi.mocked(relaunch).mockReset(); });

describe("useUpdateCheck", () => {
  it("stays idle when no update", async () => {
    vi.mocked(check).mockResolvedValue(null);
    const { result } = renderHook(() => useUpdateCheck());
    await waitFor(() => expect(result.current.status).toBe("idle"));
  });
  it("reports available, then installs + relaunches", async () => {
    const downloadAndInstall = vi.fn().mockResolvedValue(undefined);
    vi.mocked(check).mockResolvedValue({ version: "0.1.3", body: "notes", downloadAndInstall } as any);
    const { result } = renderHook(() => useUpdateCheck());
    await waitFor(() => expect(result.current.status).toBe("available"));
    expect(result.current.version).toBe("0.1.3");
    await act(async () => { await result.current.install(); });
    expect(downloadAndInstall).toHaveBeenCalled();
    expect(relaunch).toHaveBeenCalled();
  });
  it("swallows check errors to idle", async () => {
    vi.mocked(check).mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useUpdateCheck());
    await waitFor(() => expect(result.current.status).toBe("idle"));
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `npx vitest run src/hooks/use-update-check.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement the hook**

Create `src/hooks/use-update-check.ts`:
```ts
import { useCallback, useEffect, useRef, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

type Status = "idle" | "available" | "downloading" | "error";
const SIX_HOURS = 6 * 60 * 60 * 1000;

export function useUpdateCheck() {
  const [status, setStatus] = useState<Status>("idle");
  const [progress, setProgress] = useState<number | undefined>();
  const updateRef = useRef<Update | null>(null);
  const [meta, setMeta] = useState<{ version?: string; notes?: string }>({});

  const run = useCallback(async () => {
    try {
      const update = await check();
      if (update) {
        updateRef.current = update;
        setMeta({ version: update.version, notes: update.body });
        setStatus("available");
      }
    } catch {
      // background check: stay quiet (offline / rate-limited)
    }
  }, []);

  useEffect(() => {
    void run();
    const t = setInterval(() => void run(), SIX_HOURS);
    return () => clearInterval(t);
  }, [run]);

  const install = useCallback(async () => {
    const update = updateRef.current;
    if (!update) return;
    setStatus("downloading");
    try {
      let total = 0, got = 0;
      await update.downloadAndInstall((e) => {
        if (e.event === "Started") total = e.data.contentLength ?? 0;
        else if (e.event === "Progress") { got += e.data.chunkLength; if (total) setProgress(Math.round((got / total) * 100)); }
      });
      await relaunch();
    } catch {
      setStatus("error");
    }
  }, []);

  return { status, version: meta.version, notes: meta.notes, progress, install };
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `npx vitest run src/hooks/use-update-check.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/use-update-check.ts src/hooks/use-update-check.test.ts
git commit -m "feat(update): use-update-check hook (check / download / relaunch)"
```

---

### Task 10: Titlebar update indicator + release tooling

**Files:**
- Create: `src/components/titlebar/update-indicator.tsx`
- Modify: `src/components/titlebar/title-bar.tsx`
- Create: `scripts/make-latest-json.mjs`
- Create: `docs/RELEASING.md`
- Test: `src/components/titlebar/update-indicator.test.tsx` (create)

**Interfaces:**
- Consumes: `useUpdateCheck` (Task 9).

- [ ] **Step 1: Write the failing test**

Create `src/components/titlebar/update-indicator.test.tsx`:
```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const install = vi.fn();
vi.mock("@/hooks/use-update-check", () => ({ useUpdateCheck: vi.fn() }));
import { useUpdateCheck } from "@/hooks/use-update-check";
import { UpdateIndicator } from "./update-indicator";

describe("UpdateIndicator", () => {
  it("renders nothing when idle", () => {
    vi.mocked(useUpdateCheck).mockReturnValue({ status: "idle", install } as any);
    const { container } = render(<UpdateIndicator />);
    expect(container.textContent).toBe("");
  });
  it("shows a pill when available and installs on click", () => {
    vi.mocked(useUpdateCheck).mockReturnValue({ status: "available", version: "0.1.3", notes: "n", install } as any);
    render(<UpdateIndicator />);
    fireEvent.click(screen.getByRole("button", { name: /update available/i }));
    fireEvent.click(screen.getByRole("button", { name: /update & restart/i }));
    expect(install).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `npx vitest run src/components/titlebar/update-indicator.test.tsx` → FAIL (module missing).

- [ ] **Step 3: Implement the indicator**

Create `src/components/titlebar/update-indicator.tsx` (uses the existing `Popover` primitives):
```tsx
import { IconArrowUpCircle } from "@tabler/icons-react";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { useUpdateCheck } from "@/hooks/use-update-check";

export function UpdateIndicator() {
  const { status, version, notes, progress, install } = useUpdateCheck();
  if (status === "idle") return null;
  return (
    <Popover>
      <PopoverTrigger
        aria-label="Update available"
        title="Update available"
        className="flex h-7 items-center gap-1 rounded-md px-1.5 text-xs text-primary hover:bg-muted/40"
      >
        <IconArrowUpCircle className="size-4" stroke={1.75} />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 text-sm">
        <p className="font-medium">Update available{version ? ` — ${version}` : ""}</p>
        {notes && <p className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap text-xs text-muted-foreground">{notes}</p>}
        {status === "downloading" ? (
          <p className="mt-3 text-xs text-muted-foreground">Downloading… {progress ?? 0}%</p>
        ) : status === "error" ? (
          <p className="mt-3 text-xs text-destructive">Update failed — try again later.</p>
        ) : (
          <button
            type="button"
            onClick={() => void install()}
            className="mt-3 w-full rounded border border-border px-2.5 py-1 text-xs hover:bg-accent"
          >
            Update &amp; Restart
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `npx vitest run src/components/titlebar/update-indicator.test.tsx` → PASS.

- [ ] **Step 5: Mount it in the titlebar (leftmost of the right group)**

In `src/components/titlebar/title-bar.tsx`, import `import { UpdateIndicator } from "./update-indicator";` and render `<UpdateIndicator />` as the FIRST child of the `ml-auto` group (before the Files `TabButton`). No new props needed (it's self-contained).

- [ ] **Step 6: Release tooling — `make-latest-json.mjs` + `docs/RELEASING.md`**

Create `scripts/make-latest-json.mjs` that reads the built `.sig` and prints `latest.json`:
```js
// Usage: node scripts/make-latest-json.mjs <version> <sig-file> <download-url> [notes]
import { readFileSync } from "node:fs";
const [version, sigFile, url, notes = ""] = process.argv.slice(2);
if (!version || !sigFile || !url) { console.error("args: <version> <sig-file> <download-url> [notes]"); process.exit(1); }
const signature = readFileSync(sigFile, "utf8").trim();
process.stdout.write(JSON.stringify({
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: { "darwin-aarch64": { signature, url } },
}, null, 2) + "\n");
```
Create `docs/RELEASING.md`:
```md
# Releasing maincode

Releases are built and uploaded manually.

1. Bump the version in `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and `package.json`.
2. Move the `CHANGELOG.md` **Unreleased** entries under the new version heading + date.
3. Build with the updater signing key (kept in your password manager):
   ```
   export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/maincode.key)"
   export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="…"
   npm run tauri build
   ```
   This produces the `.dmg`, the `.app.tar.gz`, and its `.sig` (from `createUpdaterArtifacts`).
4. Create the GitHub release `vX.Y.Z`; upload the `.dmg` and the `.app.tar.gz`.
5. Generate the update manifest and upload it as `latest.json` on the same release:
   ```
   node scripts/make-latest-json.mjs 0.1.3 \
     src-tauri/target/release/bundle/macos/maincode.app.tar.gz.sig \
     https://github.com/champ3oy/maincode/releases/download/v0.1.3/maincode.app.tar.gz \
     "See the changelog." > latest.json
   ```
   (Adjust the `.sig` path/asset name to match the actual build output.)

**Version floor:** auto-update only works from a build that already includes the updater (0.1.3+). Users on 0.1.2 install 0.1.3 manually once.
```

- [ ] **Step 7: Typecheck + commit**

Run: `npm run typecheck 2>&1 | grep -E "update-indicator|title-bar" || echo clean` → clean.
```bash
git add src/components/titlebar/update-indicator.tsx src/components/titlebar/update-indicator.test.tsx src/components/titlebar/title-bar.tsx scripts/make-latest-json.mjs docs/RELEASING.md
git commit -m "feat(update): titlebar update indicator + release manifest tooling"
```

- [ ] **Step 8: Manual end-to-end note (out of band)**

Full verification needs two signed builds (0.1.3 then 0.1.4) with a real `latest.json` on GitHub — documented in `docs/RELEASING.md`; verify at the next release, not in this task.

---

## Self-Review

**Spec coverage:**
- F1 terminal tabs → Tasks 4–5 (strip, dock rewrite, panel active/refit, hide-inactive-mounted). ✓
- F2 auto-update → Tasks 8–10 (plugins/config/keypair, hook, indicator + release docs; version-floor documented). ✓
- F3 project-switch reset → Tasks 1–2 (reducer reset + closeAllTabs; dock keyed on root; editor reset effect). ✓
- F4 dialog fix → Task 3 (last-focused tracking + explicit target + frontend filter). ✓
- F5 AI launcher → Tasks 6–7 (Rust detect on login PATH; dropdown; openTerminalWithCommand). ✓

**Placeholder scan:** the only literal placeholder is `<PASTE_PUBLIC_KEY_FROM_STEP_1>` (Task 8) — an intentional user-supplied secret, gated by Task 8 Step 1. AI CLI binaries are concrete (incl. `agy`). No TBDs.

**Type consistency:** `AiCli { id, label, bin }` identical across Task 6 (Rust serialize), Task 7 (`ai-launcher`), and App wiring. `TerminalTab { id, title }` (Task 4) ⊂ `TermEntry` (Task 5). `TerminalDockHandle.openTerminalWithCommand(command, title)` produced in Task 5, consumed in Task 7. `menu-action` payload `{action,target}` produced in Task 3 (Rust) and consumed in Task 3 (frontend) — same task, no drift. `useUpdateCheck` return shape identical across Tasks 9–10.

**Notes for implementers:**
- Task 5 changes `TerminalDock` to a `forwardRef`; Task 2 already added `key=` and Task 5 Step 6 adds the `ref` — both edits touch the same JSX; apply in order.
- Verify exact `DropdownMenu*` / `Popover*` export names against `src/components/ui/{dropdown-menu,popover}.tsx` before writing Tasks 7 & 10 (shadcn variants differ in `onSelect` vs `onClick`).
- xterm/PTY behavior (refit, command-send, scrollback) is verified manually — jsdom can't measure xterm; unit tests cover the pure logic (reducer, strip, dock tab management, detection, update state machine).
