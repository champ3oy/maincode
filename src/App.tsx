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
import { useEditorFont } from "@/hooks/use-editor-font";
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
  CommandPalette,
  type PaletteCommand,
} from "@/components/command-palette/command-palette";
import { TerminalDock } from "@/components/terminal/terminal-dock";

function App() {
  const { rootPath, rootName, openFolder, closeFolder } = useWorkspace();
  const { workdir, status, refresh, open, close } = useRepoStatus();
  const {
    openFile,
    closeTab,
    handlePathRenamed,
    activeTab,
    saveFile,
    dirtyCount,
    tabs,
    isDirty,
  } = useEditor();
  const { addRecent } = useRecentRepos();
  const {
    increase: fontIncrease,
    decrease: fontDecrease,
    reset: fontReset,
  } = useEditorFont();
  const { setTheme } = useTheme();
  const [gitAvailable, setGitAvailable] = useState(false);
  const [gitPending, setGitPending] = useState(false);
  const [branch, setBranch] = useState<string | null>(null);
  const restoreStartedRef = useRef(false);

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

  // Cursor position for status bar
  const [cursor, setCursor] = useState<{ line: number; col: number } | null>(
    null,
  );

  // Cmd+K / Cmd+P → toggle command palette; Ctrl+` → toggle terminal
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "p")) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
      if (e.ctrlKey && e.key === "`") {
        e.preventDefault();
        setShowTerminal((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
    console.log("[maincode-font] menu-action received:", action);
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
        setShowTerminal((v) => !v);
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
    }
  };
  const menuActionRef = useRef(onMenuAction);
  menuActionRef.current = onMenuAction;
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    listen<string>("menu-action", (e) => {
      void menuActionRef.current(e.payload);
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
        run: () => setTheme("light"),
      },
      { id: "theme-dark", label: "Theme: Dark", run: () => setTheme("dark") },
      {
        id: "theme-system",
        label: "Theme: System",
        run: () => setTheme("system"),
      },
      {
        id: "toggle-terminal",
        label: "Toggle Terminal",
        run: () => setShowTerminal((v) => !v),
      },
    ],
    [activeTab, saveFile, setTheme, handleOpenFolderDialog],
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
        <CommandPalette
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          files={paletteFiles}
          onOpenFile={(rel) => void openFile(`${rootPath ?? ""}/${rel}`)}
          commands={paletteCommands}
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
          onToggleTerminal={() => setShowTerminal((v) => !v)}
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
            <ResizablePanelGroup
              orientation={
                terminalPosition === "right" ? "horizontal" : "vertical"
              }
            >
              <ResizablePanel
                defaultSize={terminalPosition === "right" ? "62%" : "70%"}
              >
                {/* Keep EditorArea mounted (hidden) so tabs/undo survive tab flips */}
                <div
                  className={cn(sidebarTab === "changes" && "hidden", "h-full")}
                >
                  <EditorArea
                    onCursor={(line, col) => setCursor({ line, col })}
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
              </ResizablePanel>
              {showTerminal && (
                <>
                  <ResizableHandle />
                  <ResizablePanel
                    defaultSize={terminalPosition === "right" ? "38%" : "30%"}
                    minSize={terminalPosition === "right" ? 240 : 80}
                  >
                    <TerminalDock
                      cwd={rootPath}
                      position={terminalPosition}
                      onTogglePosition={() =>
                        setTerminalPosition((p) =>
                          p === "bottom" ? "right" : "bottom",
                        )
                      }
                      onEmpty={() => setShowTerminal(false)}
                    />
                  </ResizablePanel>
                </>
              )}
            </ResizablePanelGroup>
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
          />
        )}
      </div>
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        files={paletteFiles}
        onOpenFile={(rel) => void openFile(`${rootPath}/${rel}`)}
        commands={paletteCommands}
      />
      <Toaster />
    </>
  );
}

export default App;
