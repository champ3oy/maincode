import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ask } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
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
import { getLaunchPath, getRepoBranch } from "@/lib/tauri";
import { useEditor } from "@/hooks/use-editor";
import { EditorArea } from "@/components/editor/editor-area";
import {
  createFile,
  createDir,
  renamePath,
  deletePath,
} from "@/lib/fs";

function App() {
  const { rootPath, rootName, openFolder } = useWorkspace();
  const { workdir, status, refresh, open, close } = useRepoStatus();
  const { openFile, closeTab, handlePathRenamed } = useEditor();
  const { addRecent } = useRecentRepos();
  const [gitAvailable, setGitAvailable] = useState(false);
  const [gitPending, setGitPending] = useState(false);
  const [branch, setBranch] = useState<string | null>(null);
  const restoreStartedRef = useRef(false);

  // File tree refresh nonce: bump to trigger a tree reload
  const [treeRefreshNonce, setTreeRefreshNonce] = useState(0);
  const bumpTree = useCallback(() => setTreeRefreshNonce((n) => n + 1), []);

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
    async (name: string) => {
      if (!pendingOp) return;
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
      } catch (e) {
        toast.error(`Operation failed: ${e}`);
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

  // Restore: CLI launch path first, then last opened folder.
  useEffect(() => {
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

  if (!rootPath) {
    return (
      <>
        <Welcome onOpenFolder={openFolderAndRecord} />
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
        onConfirm={(name) => void handleNameConfirm(name)}
        onOpenChange={(o) => {
          if (!o) setPendingOp(null);
        }}
      />
      <div className="flex h-full flex-col">
        <ResizablePanelGroup
          orientation="horizontal"
          className="isolate min-h-0 flex-1 border-t border-border bg-background"
        >
          <ResizablePanel defaultSize="22%" minSize={220} maxSize={400}>
            <div className="flex h-full flex-col bg-sidebar">
              <div className="flex h-10 items-center border-b border-border px-3">
                <span className="min-w-0 flex-1 truncate text-xs font-semibold">
                  {rootName}
                </span>
                <button
                  type="button"
                  title="New File"
                  className="ml-1 flex h-6 w-6 items-center justify-center rounded hover:bg-accent"
                  onClick={() =>
                    void handleFileOp({ kind: "new-file", dir: rootPath })
                  }
                >
                  <span className="text-xs leading-none">+F</span>
                </button>
                <button
                  type="button"
                  title="New Folder"
                  className="ml-1 flex h-6 w-6 items-center justify-center rounded hover:bg-accent"
                  onClick={() =>
                    void handleFileOp({ kind: "new-folder", dir: rootPath })
                  }
                >
                  <span className="text-xs leading-none">+D</span>
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-auto p-2">
                <FileTree
                  rootPath={rootPath}
                  onOpenFile={(path) => void openFile(path)}
                  onFileOp={handleFileOp}
                  refreshNonce={treeRefreshNonce}
                />
              </div>
            </div>
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel defaultSize="78%">
            <EditorArea />
          </ResizablePanel>
        </ResizablePanelGroup>
        {gitAvailable && workdir ? (
          <StatusBar
            workdir={workdir}
            branch={branch}
            onOpenRepo={async (path: string) => {
              openFolderAndRecord(path);
              return path;
            }}
            onBranchSwitched={handleBranchSwitched}
          />
        ) : gitPending ? (
          <div className="h-7 border-t border-border" />
        ) : (
          <footer className="flex h-7 items-center border-t border-border px-3">
            <span className="text-muted-foreground text-xs">
              {rootName} — not a git repository
            </span>
          </footer>
        )}
      </div>
      <Toaster />
    </>
  );
}

export default App;
