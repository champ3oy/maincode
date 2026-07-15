import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, open as openDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { useTheme } from "next-themes";
import {
  IconFilePlus,
  IconFolderPlus,
  IconSearch,
  IconX,
} from "@tabler/icons-react";
import { languageKeyForPath, LANGUAGE_LABELS } from "@/lib/language";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { Toaster } from "@/components/ui/sonner";
import { StatusBar } from "@/components/status-bar/status-bar";
import { FileTree, type FileOp } from "@/components/file-tree/file-tree";
import { NameDialog } from "@/components/file-tree/name-dialog";
import { Welcome } from "@/components/welcome/welcome";
import { useRepoStatus } from "@/hooks/use-repo-status";
import { useRecentRepos } from "@/hooks/use-recent-repos";
import { readLastFolder, useWorkspace } from "@/hooks/use-workspace";
import { useSettings } from "@/hooks/use-settings";
import {
  getLaunchPath,
  getRepoBranch,
  stageFile,
  unstageFile,
  stageAll,
  unstageAll,
  commit,
  discardFile,
  type CommitOptions,
  type FileEntry,
} from "@/lib/tauri";
import { useEditor } from "@/hooks/use-editor";
import { SETTINGS_PATH } from "@/lib/settings";
import { EditorArea } from "@/components/editor/editor-area";
import { DiffPanel } from "@/components/diff-panel/diff-panel";
import { useDiffs } from "@/hooks/use-diffs";
import { TitleBar, type SidebarTab } from "@/components/titlebar/title-bar";
import { SourceControlPanel } from "@/components/source-control/source-control-panel";
import { cn } from "@/lib/utils";
import {
  createFile,
  createDir,
  renamePath,
  deletePath,
  listFilesRecursive,
} from "@/lib/fs";
import {
  CommandCenter,
  type PaletteCommand,
} from "@/components/command-center/command-center";
import {
  TerminalDock,
  type TerminalDockHandle,
} from "@/components/terminal/terminal-dock";
import { setProjectRoot, warmServer } from "@/lib/intelligence";
import { invoke } from "@tauri-apps/api/core";
import type { DefinitionResult } from "@/lib/ts-worker/protocol";

function App() {
  const { rootPath, rootName, openFolder, closeFolder } = useWorkspace();
  const { workdir, status, refresh, open, close } = useRepoStatus();
  const {
    openFile,
    closeTab,
    closeAllTabs,
    handlePathRenamed,
    activeTab,
    saveFile,
    formatFile,
    setFormatRoot,
    dirtyCount,
    tabs,
    isDirty,
  } = useEditor();
  const { addRecent, recent } = useRecentRepos();
  const { settings, patch } = useSettings();
  const { setTheme } = useTheme();

  // Bridge: whenever settings.theme changes, apply it to next-themes.
  useEffect(() => {
    setTheme(settings.theme);
  }, [settings.theme, setTheme]);

  // Keep use-editor's formatRootRef in sync so .prettierrc config is resolved
  // from the correct project directory on format actions.
  useEffect(() => {
    setFormatRoot(rootPath);
  }, [rootPath, setFormatRoot]);

  // Opening a different project must not carry the previous project's tabs.
  // Skip the initial mount (nothing to clear) and same-path re-selection.
  const prevRootRef = useRef<string | null>(null);
  useEffect(() => {
    if (prevRootRef.current !== null && prevRootRef.current !== rootPath) {
      closeAllTabs();
    }
    prevRootRef.current = rootPath;
  }, [rootPath, closeAllTabs]);

  // Set (or clear) the project root on the client manager so per-language LSP
  // clients are lazily created/opened as files route to them. When the project
  // has Rust, pre-warm rust-analyzer so its slow first index runs in the
  // background before the user opens a .rs file (its progress shows in the
  // status bar).
  useEffect(() => {
    const root = rootPath && settings.editor.languageIntelligence ? rootPath : null;
    setProjectRoot(root);
    if (!root) return;
    // Stale-guard: if the project switches while has_cargo_project is in
    // flight, the old continuation must not warm rust-analyzer against the
    // new (possibly non-cargo) root.
    let stale = false;
    void invoke<boolean>("has_cargo_project", { root })
      .then((yes) => {
        if (yes && !stale) warmServer("rust");
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [rootPath, settings.editor.languageIntelligence]);

  function clampFontSize(size: number): number {
    return Math.min(32, Math.max(8, Math.round(size)));
  }

  function fontIncrease() {
    patch({ editor: { fontSize: clampFontSize(settings.editor.fontSize + 1) } });
  }
  function fontDecrease() {
    patch({ editor: { fontSize: clampFontSize(settings.editor.fontSize - 1) } });
  }
  function fontReset() {
    patch({ editor: { fontSize: 13 } });
  }
  const [gitAvailable, setGitAvailable] = useState(false);
  const [gitPending, setGitPending] = useState(false);
  const [branch, setBranch] = useState<string | null>(null);
  const restoreStartedRef = useRef(false);
  const terminalDockRef = useRef<TerminalDockHandle | null>(null);

  // Source control panel state
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("files");
  const [scrollToPath, setScrollToPath] = useState<string | null>(null);
  const [scrollNonce, setScrollNonce] = useState(0);
  const [diffStyle, setDiffStyle] = useState<"unified" | "split">("split");
  const [allExpanded, setAllExpanded] = useState(true);
  const [selectedChangedPath, setSelectedChangedPath] = useState<string | null>(
    null,
  );

  const { diffs, loading: diffsLoading } = useDiffs(
    status?.staged,
    status?.unstaged,
  );

  const allFiles = useMemo((): FileEntry[] => {
    if (!status) return [];
    const seen = new Set<string>();
    const files: FileEntry[] = [];
    for (const f of [...status.staged, ...status.unstaged]) {
      if (!seen.has(f.path)) {
        seen.add(f.path);
        files.push(f);
      }
    }
    return files;
  }, [status]);

  // File tree search
  const [treeSearchOpen, setTreeSearchOpen] = useState(false);
  const [treeSearch, setTreeSearch] = useState("");

  // File tree refresh nonce: bump to trigger a tree reload
  const [treeRefreshNonce, setTreeRefreshNonce] = useState(0);
  const bumpTree = useCallback(() => setTreeRefreshNonce((n) => n + 1), []);

  // Command palette state
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteFiles, setPaletteFiles] = useState<string[]>([]);

  // Terminal panel state
  const [showTerminal, setShowTerminal] = useState(false);
  const [terminalPosition, setTerminalPosition] = useState<"bottom" | "right">(
    "bottom",
  );
  // Once opened, the terminal dock stays mounted; hiding it is done via
  // display:none (the `hidden` class) so shells/scrollback/splits and the
  // xterm DOM survive — no unmount, no re-parent, no glitch.
  const [terminalMounted, setTerminalMounted] = useState(false);
  const TERM_DEFAULT_BOTTOM = 260; // px height
  const TERM_DEFAULT_RIGHT = 420; // px width
  const [terminalSize, setTerminalSize] = useState(TERM_DEFAULT_BOTTOM);

  const toggleTerminal = useCallback(() => {
    setTerminalMounted(true);
    setShowTerminal((v) => !v);
  }, []);

  const toggleTerminalPosition = useCallback(() => {
    setTerminalPosition((p) => {
      const next = p === "bottom" ? "right" : "bottom";
      setTerminalSize(next === "right" ? TERM_DEFAULT_RIGHT : TERM_DEFAULT_BOTTOM);
      return next;
    });
  }, []);

  // Drag the divider to resize the terminal (height when docked bottom, width
  // when docked right).
  const startTerminalResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const isRight = terminalPosition === "right";
      const startPos = isRight ? e.clientX : e.clientY;
      const startSize = terminalSize;
      const onMove = (ev: MouseEvent) => {
        const cur = isRight ? ev.clientX : ev.clientY;
        // Dragging toward the editor (left for right-dock, up for bottom-dock)
        // grows the terminal.
        const delta = startPos - cur;
        const axisMax = (isRight ? window.innerWidth : window.innerHeight) - 200;
        setTerminalSize(
          Math.min(Math.max(startSize + delta, 120), Math.max(200, axisMax)),
        );
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        document.body.style.userSelect = "";
      };
      document.body.style.userSelect = "none";
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [terminalPosition, terminalSize],
  );

  // Cursor position for status bar
  const [cursor, setCursor] = useState<{ line: number; col: number } | null>(
    null,
  );

  // Go-to-definition: after a Cmd/Ctrl+Click resolves a target, open the target
  // file and stash a one-shot reveal so the mounted editor jumps to the line.
  // The active editor consumes and clears it (onRevealConsumed).
  const [revealTarget, setRevealTarget] = useState<DefinitionResult | null>(
    null,
  );
  const handleGoToDefinition = useCallback(
    (target: DefinitionResult) => {
      // openFile activates an existing tab or opens a new one. Set the reveal
      // after opening so the editor (already-mounted for same-file, or freshly
      // mounted for cross-file) scrolls to the target line once it renders.
      void openFile(target.path).then(() => setRevealTarget(target));
    },
    [openFile],
  );

  // Cmd+K / Cmd+P → toggle command palette; Ctrl+` → toggle terminal
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
      if (e.ctrlKey && e.key === "`") {
        e.preventDefault();
        toggleTerminal();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleTerminal]);

  // Suppress the native webview context menu (the dev "Reload / Inspect
  // Element" menu) everywhere except text fields and the code editor, where
  // the native copy/paste menu is still useful. The file tree renders its own
  // menu via @pierre/trees.
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target?.closest("input, textarea, [contenteditable='true'], .cm-editor")
      ) {
        return;
      }
      e.preventDefault();
    };
    window.addEventListener("contextmenu", onContextMenu);
    return () => window.removeEventListener("contextmenu", onContextMenu);
  }, []);

  // Reflect the open project in the native window title (used by the Dock menu
  // window list and the app switcher). Empty windows show "Maincode".
  useEffect(() => {
    void getCurrentWindow().setTitle(rootName ?? "Maincode");
  }, [rootName]);

  // Load workspace files when palette opens; clear stale list on close.
  useEffect(() => {
    if (!paletteOpen) {
      setPaletteFiles([]);
      return;
    }
    if (!rootPath) return;
    let stale = false;
    listFilesRecursive(rootPath)
      .then((files) => {
        if (!stale) setPaletteFiles(files);
      })
      .catch(() => {
        if (!stale) setPaletteFiles([]);
      });
    return () => {
      stale = true;
    };
  }, [paletteOpen, rootPath]);

  // Pending file op waiting for name input
  const [pendingOp, setPendingOp] = useState<FileOp | null>(null);

  const handleFileOp = useCallback(
    async (op: FileOp) => {
      if (op.kind === "delete") {
        const ok = await ask(
          `Delete ${op.name}${op.isDir ? " and all its contents" : ""}? This cannot be undone.`,
          { title: "Delete", kind: "warning" },
        );
        if (!ok) return;
        try {
          await deletePath(op.path);
          closeTab(op.path);
          bumpTree();
        } catch (e) {
          toast.error(`Delete failed: ${e}`);
        }
        return;
      }
      setPendingOp(op);
    },
    [closeTab, bumpTree],
  );

  const handleNameConfirm = useCallback(
    async (name: string): Promise<boolean> => {
      if (!pendingOp) return false;
      try {
        if (pendingOp.kind === "new-file") {
          await createFile(`${pendingOp.dir}/${name}`);
        } else if (pendingOp.kind === "new-folder") {
          await createDir(`${pendingOp.dir}/${name}`);
        } else if (pendingOp.kind === "rename") {
          const parent = pendingOp.path.slice(
            0,
            pendingOp.path.lastIndexOf("/"),
          );
          const to = `${parent}/${name}`;
          await renamePath(pendingOp.path, to);
          handlePathRenamed(pendingOp.path, to);
        }
        bumpTree();
        setPendingOp(null);
        return true;
      } catch (e) {
        toast.error(`Operation failed: ${e}`);
        return false;
      }
    },
    [pendingOp, handlePathRenamed, bumpTree],
  );

  const nameDialogTitle =
    pendingOp?.kind === "new-file"
      ? "New File"
      : pendingOp?.kind === "new-folder"
        ? "New Folder"
        : "Rename";
  const nameDialogInitialValue =
    pendingOp?.kind === "rename" ? pendingOp.name : "";
  const nameDialogConfirmLabel =
    pendingOp?.kind === "rename" ? "Rename" : "Create";

  const openFolderAndRecord = useCallback(
    (path: string) => {
      openFolder(path);
      addRecent(path);
    },
    [openFolder, addRecent],
  );
  const openFolderRef = useRef(openFolderAndRecord);
  openFolderRef.current = openFolderAndRecord;

  const handleOpenFolderDialog = useCallback(async () => {
    const selected = await openDialog({ directory: true, multiple: false });
    if (typeof selected === "string") openFolderAndRecord(selected);
  }, [openFolderAndRecord]);

  // Native menu actions (from src-tauri/src/menu.rs via the "menu-action"
  // event). Kept in a latest-ref so the listener subscribes only once.
  const onMenuAction = async (action: string) => {
    switch (action) {
      case "new-file":
        if (rootPath) {
          setSidebarTab("files");
          void handleFileOp({ kind: "new-file", dir: rootPath });
        }
        break;
      case "open-folder":
        void handleOpenFolderDialog();
        break;
      case "save":
        if (activeTab) void saveFile(activeTab.path);
        break;
      case "save-all":
        for (const t of tabs) if (isDirty(t)) void saveFile(t.path);
        break;
      case "close-editor":
        if (activeTab) {
          if (isDirty(activeTab)) {
            const ok = await ask(`Close ${activeTab.name} without saving?`, {
              title: "Unsaved changes",
              kind: "warning",
            });
            if (!ok) return;
          }
          closeTab(activeTab.path);
        }
        break;
      case "close-folder":
        closeFolder();
        break;
      case "command-palette":
        setPaletteOpen((v) => !v);
        break;
      case "search-files":
        setSidebarTab("files");
        setTreeSearchOpen(true);
        break;
      case "toggle-terminal":
        toggleTerminal();
        break;
      case "font-increase":
        fontIncrease();
        break;
      case "font-decrease":
        fontDecrease();
        break;
      case "font-reset":
        fontReset();
        break;
      case "open-settings":
        void openFile(SETTINGS_PATH);
        break;
      case "format-document":
        if (activeTab) void formatFile(activeTab.path);
        break;
    }
  };
  const menuActionRef = useRef(onMenuAction);
  menuActionRef.current = onMenuAction;
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

  const paletteCommands = useMemo<PaletteCommand[]>(
    () => [
      {
        id: "open-folder",
        label: "Open Folder…",
        run: () => void handleOpenFolderDialog(),
      },
      {
        id: "save",
        label: "Save Active File",
        run: () => {
          if (activeTab) void saveFile(activeTab.path);
        },
      },
      {
        id: "tab-files",
        label: "Show Files",
        run: () => setSidebarTab("files"),
      },
      {
        id: "tab-changes",
        label: "Show Changes",
        run: () => setSidebarTab("changes"),
      },
      {
        id: "theme-light",
        label: "Theme: Light",
        run: () => patch({ theme: "light" }),
      },
      { id: "theme-dark", label: "Theme: Dark", run: () => patch({ theme: "dark" }) },
      {
        id: "theme-system",
        label: "Theme: System",
        run: () => patch({ theme: "system" }),
      },
      {
        id: "toggle-terminal",
        label: "Toggle Terminal",
        run: () => toggleTerminal(),
      },
      {
        id: "open-settings",
        label: "Open Settings",
        run: () => void openFile(SETTINGS_PATH),
      },
      {
        id: "format-document",
        label: "Format Document",
        run: () => {
          if (activeTab) void formatFile(activeTab.path);
        },
      },
    ],
    [
      activeTab,
      saveFile,
      formatFile,
      patch,
      handleOpenFolderDialog,
      openFile,
      toggleTerminal,
    ],
  );

  // Restore the CLI launch path / last folder only in the primary window;
  // every New Window (label "w-N") starts empty on the Welcome screen.
  useEffect(() => {
    if (getCurrentWindow().label !== "main") return;
    let cancelled = false;
    getLaunchPath()
      .then((launchPath) => {
        if (cancelled || restoreStartedRef.current) return;
        const restorePath = launchPath ?? readLastFolder();
        if (!restorePath) return;
        restoreStartedRef.current = true;
        openFolderRef.current(restorePath);
      })
      .catch((e) => console.error("[maincode] getLaunchPath failed:", e));
    return () => {
      cancelled = true;
    };
  }, []);

  // Try to attach git whenever the workspace root changes. Non-repos are
  // fine — the editor works either way, git UI just stays disabled.
  const gitOpenRef = useRef(open);
  gitOpenRef.current = open;
  const gitCloseRef = useRef(close);
  gitCloseRef.current = close;
  useEffect(() => {
    if (!rootPath) {
      gitCloseRef.current();
      setGitAvailable(false);
      setGitPending(false);
      return;
    }
    let cancelled = false;
    setGitPending(true);
    gitOpenRef
      .current(rootPath)
      .then(() => {
        if (!cancelled) {
          setGitAvailable(true);
          setGitPending(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          gitCloseRef.current();
          setGitAvailable(false);
          setGitPending(false);
        }
      });
    return () => {
      cancelled = true;
      gitCloseRef.current();
    };
  }, [rootPath]);

  // Auto-refresh git status on watcher events.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    if (!workdir) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    listen("repo:changed", () => refreshRef.current()).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [workdir]);

  // Track the current branch.
  useEffect(() => {
    if (!workdir) {
      setBranch(null);
      return;
    }
    let cancelled = false;
    getRepoBranch(workdir)
      .then((b) => {
        if (!cancelled) setBranch(b);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [workdir, status]);

  const handleBranchSwitched = useCallback(async () => {
    await refresh();
    if (!workdir) return;
    try {
      setBranch(await getRepoBranch(workdir));
    } catch {
      // ignore
    }
  }, [refresh, workdir]);

  // Git staging/commit handlers
  const handleStage = useCallback(
    async (path: string) => {
      try {
        await stageFile(path);
        await refresh();
      } catch (e) {
        toast.error(`Stage failed: ${e}`);
      }
    },
    [refresh],
  );

  const handleUnstage = useCallback(
    async (path: string) => {
      try {
        await unstageFile(path);
        await refresh();
      } catch (e) {
        toast.error(`Unstage failed: ${e}`);
      }
    },
    [refresh],
  );

  const handleStageAll = useCallback(async () => {
    try {
      await stageAll();
      await refresh();
    } catch (e) {
      toast.error(`Stage all failed: ${e}`);
    }
  }, [refresh]);

  const handleUnstageAll = useCallback(async () => {
    try {
      await unstageAll();
      await refresh();
    } catch (e) {
      toast.error(`Unstage all failed: ${e}`);
    }
  }, [refresh]);

  const handleCommit = useCallback(
    async (message: string, options?: CommitOptions) => {
      try {
        const oid = await commit(message, options);
        toast.success(
          `${options?.amend ? "Amended" : "Committed"}: ${oid.slice(0, 7)}`,
        );
        await refresh();
      } catch (e) {
        toast.error(`Commit failed: ${e}`);
      }
    },
    [refresh],
  );

  const handleDiscardFile = useCallback(
    async (path: string) => {
      const ok = await ask(
        `Discard changes to ${path}? This cannot be undone.`,
        { title: "Discard changes", kind: "warning" },
      );
      if (!ok) return;
      try {
        await discardFile(path);
        await refresh();
        toast.success(`Discarded ${path}`);
      } catch (e) {
        toast.error(`Discard failed: ${e}`);
      }
    },
    [refresh],
  );

  const handleSelectChangedFile = useCallback((path: string) => {
    setSelectedChangedPath(path);
    setScrollToPath(path);
    setScrollNonce((n) => n + 1);
  }, []);

  if (!rootPath) {
    return (
      <>
        <Welcome onOpenFolder={openFolderAndRecord} />
        <CommandCenter
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          files={paletteFiles}
          onOpenFile={(rel) => void openFile(`${rootPath ?? ""}/${rel}`)}
          commands={paletteCommands}
          recent={recent}
          onOpenRecent={(path) => openFolderAndRecord(path)}
        />
        <Toaster />
      </>
    );
  }

  return (
    <>
      <NameDialog
        open={pendingOp !== null}
        title={nameDialogTitle}
        initialValue={nameDialogInitialValue}
        confirmLabel={nameDialogConfirmLabel}
        onConfirm={handleNameConfirm}
        onOpenChange={(o) => {
          if (!o) setPendingOp(null);
        }}
      />
      <div className="flex h-full flex-col">
        <TitleBar
          activeTab={sidebarTab}
          gitAvailable={gitAvailable}
          changeCount={
            (status?.staged.length ?? 0) + (status?.unstaged.length ?? 0)
          }
          onSelectTab={setSidebarTab}
          showTerminal={showTerminal}
          onToggleTerminal={toggleTerminal}
          onLaunchAiCli={(cli) => {
            setShowTerminal(true);
            terminalDockRef.current?.openTerminalWithCommand(
              cli.bin,
              cli.label,
            );
          }}
        />
        <ResizablePanelGroup
          orientation="horizontal"
          className="isolate min-h-0 flex-1 bg-background"
        >
          <ResizablePanel defaultSize="180px" minSize={180} maxSize={300}>
            <div className="flex h-full flex-col bg-sidebar">
              {/* Files tab header (New File / New Folder buttons) */}
              {sidebarTab === "files" && (
                <div className="flex h-9 items-center border-b border-border px-3">
                  <span className="min-w-0 flex-1 truncate text-xs font-semibold">
                    {rootName}
                  </span>
                  <button
                    type="button"
                    title="Search files"
                    className={cn(
                      "ml-1 flex h-6 w-6 items-center justify-center rounded hover:bg-accent",
                      treeSearchOpen && "bg-accent text-accent-foreground",
                    )}
                    onClick={() =>
                      setTreeSearchOpen((v) => {
                        if (v) setTreeSearch("");
                        return !v;
                      })
                    }
                  >
                    <IconSearch className="size-4" stroke={1.75} />
                  </button>
                  <button
                    type="button"
                    title="New File"
                    className="ml-1 flex h-6 w-6 items-center justify-center rounded hover:bg-accent"
                    onClick={() =>
                      void handleFileOp({ kind: "new-file", dir: rootPath })
                    }
                  >
                    <IconFilePlus className="size-4" stroke={1.75} />
                  </button>
                  <button
                    type="button"
                    title="New Folder"
                    className="ml-1 flex h-6 w-6 items-center justify-center rounded hover:bg-accent"
                    onClick={() =>
                      void handleFileOp({ kind: "new-folder", dir: rootPath })
                    }
                  >
                    <IconFolderPlus className="size-4" stroke={1.75} />
                  </button>
                </div>
              )}
              {sidebarTab === "files" && treeSearchOpen && (
                <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-border px-3">
                  <IconSearch className="text-muted-foreground size-3.5 shrink-0" />
                  <input
                    autoFocus
                    value={treeSearch}
                    onChange={(e) => setTreeSearch(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        setTreeSearch("");
                        setTreeSearchOpen(false);
                      }
                    }}
                    placeholder="Search names & contents…"
                    className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-xs outline-none"
                  />
                  {treeSearch && (
                    <button
                      type="button"
                      title="Clear"
                      className="text-muted-foreground shrink-0 rounded p-0.5 hover:bg-accent hover:text-foreground"
                      onClick={() => setTreeSearch("")}
                    >
                      <IconX className="size-3.5" />
                    </button>
                  )}
                </div>
              )}
              {/* Sidebar body: Files or Changes */}
              {sidebarTab === "files" ? (
                <div className="min-h-0 flex-1 overflow-auto p-2">
                  <FileTree
                    rootPath={rootPath}
                    onOpenFile={(path) => void openFile(path)}
                    onFileOp={handleFileOp}
                    refreshNonce={treeRefreshNonce}
                    searchQuery={treeSearchOpen ? treeSearch : ""}
                  />
                </div>
              ) : (
                <div className="min-h-0 flex-1 overflow-hidden">
                  <SourceControlPanel
                    staged={status?.staged ?? []}
                    unstaged={status?.unstaged ?? []}
                    selectedPath={selectedChangedPath}
                    onSelectFile={handleSelectChangedFile}
                    onStage={(path) => void handleStage(path)}
                    onUnstage={(path) => void handleUnstage(path)}
                    onStageAll={() => void handleStageAll()}
                    onUnstageAll={() => void handleUnstageAll()}
                    onCommit={(msg, opts) => void handleCommit(msg, opts)}
                    onDiscardFile={(path) => void handleDiscardFile(path)}
                  />
                </div>
              )}
            </div>
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel>
            <div
              className={cn(
                "flex h-full min-h-0 min-w-0",
                terminalPosition === "right" ? "flex-row" : "flex-col",
              )}
            >
              {/* Editor fills all space the terminal doesn't take. */}
              <div className="relative min-h-0 min-w-0 flex-1">
                {/* Keep EditorArea mounted (hidden) so tabs/undo survive tab flips */}
                <div
                  className={cn(sidebarTab === "changes" && "hidden", "h-full")}
                >
                  <EditorArea
                    onCursor={(line, col) => setCursor({ line, col })}
                    formatRoot={rootPath}
                    onGoToDefinition={
                      settings.editor.languageIntelligence
                        ? handleGoToDefinition
                        : undefined
                    }
                    revealTarget={revealTarget}
                    onRevealConsumed={() => setRevealTarget(null)}
                  />
                </div>
                {sidebarTab === "changes" && (
                  <DiffPanel
                    files={allFiles}
                    diffs={diffs}
                    loading={diffsLoading}
                    diffStyle={diffStyle}
                    onDiffStyleChange={setDiffStyle}
                    allExpanded={allExpanded}
                    onToggleExpandAll={() => setAllExpanded((v) => !v)}
                    scrollToPath={scrollToPath}
                    scrollNonce={scrollNonce}
                  />
                )}
              </div>

              {/* Terminal: mounted once opened, then only HIDDEN (display:none)
                  so its shells, scrollback, and splits survive — the xterm DOM
                  never moves. */}
              {terminalMounted && (
                <>
                  {/* 1px visual line with a wide invisible grab strip (the
                      ::after) so it's actually draggable — a bare 1px div can't
                      be clicked. Mirrors the ResizableHandle hit-area trick. */}
                  <div
                    onMouseDown={startTerminalResize}
                    className={cn(
                      "relative z-10 shrink-0 bg-border transition-colors hover:bg-primary/50",
                      terminalPosition === "right"
                        ? "w-px cursor-col-resize after:absolute after:inset-y-0 after:left-1/2 after:w-2 after:-translate-x-1/2"
                        : "h-px cursor-row-resize after:absolute after:inset-x-0 after:top-1/2 after:h-2 after:-translate-y-1/2",
                      !showTerminal && "hidden",
                    )}
                  />
                  <div
                    className={cn(
                      "min-h-0 min-w-0 shrink-0",
                      !showTerminal && "hidden",
                    )}
                    style={
                      terminalPosition === "right"
                        ? { width: terminalSize }
                        : { height: terminalSize }
                    }
                  >
                    <TerminalDock
                      key={rootPath ?? "no-project"}
                      ref={terminalDockRef}
                      cwd={rootPath}
                      position={terminalPosition}
                      onTogglePosition={toggleTerminalPosition}
                      onEmpty={() => {
                        setShowTerminal(false);
                        setTerminalMounted(false);
                      }}
                    />
                  </div>
                </>
              )}
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
        {gitPending ? (
          <div className="h-7 border-t border-border" />
        ) : (
          <StatusBar
            workdir={rootPath}
            branch={branch}
            gitAvailable={gitAvailable}
            cursor={cursor}
            languageLabel={
              activeTab
                ? (() => {
                    const key = languageKeyForPath(activeTab.path);
                    return key ? LANGUAGE_LABELS[key] : null;
                  })()
                : null
            }
            dirtyCount={dirtyCount}
            onOpenRepo={async (path: string) => {
              openFolderAndRecord(path);
              return path;
            }}
            onBranchSwitched={handleBranchSwitched}
            onOpenSettings={() => void openFile(SETTINGS_PATH)}
          />
        )}
      </div>
      <CommandCenter
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        files={paletteFiles}
        onOpenFile={(rel) => void openFile(`${rootPath}/${rel}`)}
        commands={paletteCommands}
        recent={recent}
        onOpenRecent={(path) => openFolderAndRecord(path)}
      />
      <Toaster />
    </>
  );
}

export default App;
