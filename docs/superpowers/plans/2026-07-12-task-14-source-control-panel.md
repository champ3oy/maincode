# Task 14: Source Control Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a source control panel with staged/unstaged file trees (using `@pierre/trees` in git-status mode), a diff center pane, and staging/commit handlers; wired into App.tsx behind a "Files/Changes" tab switch.

**Architecture:** Three new components (`SidebarSwitch`, `SourceControlPanel`, `SidebarContextMenu` for stage/unstage/discard) plus App.tsx modifications to hold `sidebarTab` state, git handlers, `useDiffs`, and center-pane switching between `EditorArea` and `DiffPanel`.

**Tech Stack:** React 19, TypeScript, `@pierre/trees` (FileTree + useFileTree + useFileTreeSelection), `@pierre/diffs` (DiffPanel already exists), Tauri v2 commands, Tailwind CSS, Sonner toasts.

## Global Constraints

- `@pierre/trees` version `^1.0.0-beta.4` — use `gitStatus` + `mapKind` for colored icons, `initialExpansion: 'open'`, `density: 'compact'`
- No hand-rolled FileRow list — use `FileTree` component with git-status mode
- Each tree needs unique `id` prop: `"sc-staged-tree"` and `"sc-unstaged-tree"`
- `DiffPanel` props: `{ files, diffs, loading, diffStyle, onDiffStyleChange, allExpanded, onToggleExpandAll, scrollToPath, scrollNonce }`
- `CommitBar` props: `{ stagedCount, onCommit }`
- `EditorArea` must stay MOUNTED but hidden (className `hidden`) when Changes tab is active
- No optimistic updates — simple await+refresh+toast pattern

---

### Task 1: Create `SidebarSwitch` component

**Files:**
- Create: `src/components/sidebar/sidebar-switch.tsx`

**Interfaces:**
- Produces: `SidebarSwitch({ active, changeCount, gitAvailable, onSelect })`, `SidebarTab` type

- [x] **Step 1: Create the component**

Already have the exact code from the brief. Create the file with the tab switcher.

- [x] **Step 2: Verify typecheck**

Run: `cd /Users/cirx/Desktop/projects/personal/maincode/cub.dev && bun run typecheck`

---

### Task 2: Create `SourceControlPanel` component with @pierre/trees

**Files:**
- Create: `src/components/source-control/source-control-panel.tsx`
- Create: `src/components/source-control/sc-context-menu.tsx`

**Interfaces:**
- Consumes: `FileEntry[]` from `@/lib/tauri`, `FileTree/useFileTree/useFileTreeSelection` from `@pierre/trees/react`, `CommitBar` from `@/components/sidebar/commit-bar`
- Produces: `SourceControlPanel` with `{ staged, unstaged, selectedPath, onSelectFile, onStage, onUnstage, onStageAll, onUnstageAll, onCommit, onDiscardFile }` props

- [x] **Step 1: Create the SourceControlPanel using @pierre/trees git-status mode**

Port cub's `Section` component pattern — two sections (Staged + Changes), each with a `FileTree` using `gitStatus` entries and `mapKind`. Use `renderContextMenu` for Stage/Unstage/Discard actions.

- [x] **Step 2: Verify typecheck**

---

### Task 3: Wire everything into App.tsx

**Files:**
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `SidebarSwitch`, `SourceControlPanel`, `DiffPanel`, `useDiffs`, `SidebarTab`
- State additions: `sidebarTab`, `scrollToPath`, `scrollNonce`, `diffStyle`, `allExpanded`
- Git handlers: `handleStage/handleUnstage/handleStageAll/handleUnstageAll/handleCommit/handleDiscardFile/handleSelectChangedFile`

- [x] **Step 1: Add all new state and handlers**
- [x] **Step 2: Modify sidebar rendering (SidebarSwitch + conditional body)**
- [x] **Step 3: Modify center pane (DiffPanel when Changes tab, EditorArea otherwise + keep mounted)**
- [x] **Step 4: Verify typecheck + tests pass**
- [x] **Step 5: Commit**
