import { useCallback, useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";
import { StatusBar } from "@/components/status-bar/status-bar";
import {
  clearLastOpenedRepo,
  readLastOpenedRepo,
  useRepoStatus,
} from "@/hooks/use-repo-status";
import { useRecentRepos } from "@/hooks/use-recent-repos";
import { getLaunchPath, getRepoBranch } from "@/lib/tauri";

function App() {
  const { workdir, status, error, refresh, open } = useRepoStatus();
  const { addRecent } = useRecentRepos();
  const [branch, setBranch] = useState<string | null>(null);
  const restoreOpenStartedRef = useRef(false);

  const openAndRecord = useCallback(
    async (path: string) => {
      const dir = await open(path);
      addRecent(dir);
      return dir;
    },
    [open, addRecent],
  );
  const openRef = useRef(openAndRecord);
  openRef.current = openAndRecord;

  // Honor a CLI launch path first; otherwise restore the last opened repo.
  useEffect(() => {
    let cancelled = false;
    getLaunchPath()
      .then((launchPath) => {
        if (cancelled) return;
        const restorePath = launchPath ?? readLastOpenedRepo();
        if (!restorePath || restoreOpenStartedRef.current) return;
        restoreOpenStartedRef.current = true;
        openRef.current(restorePath).catch((e) => {
          if (!launchPath) clearLastOpenedRepo();
          toast.error(`Failed to open: ${e}`);
        });
      })
      .catch((e) => console.error("[maincode] getLaunchPath failed:", e));
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-refresh git status when the watcher reports disk changes.
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

  // Track the current branch; status changes fire after commit/checkout.
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

  const handleOpenClick = useCallback(async () => {
    const selected = await openDialog({ directory: true, multiple: false });
    if (typeof selected === "string") {
      openRef.current(selected).catch((e) => toast.error(`Failed to open: ${e}`));
    }
  }, []);

  const handleBranchSwitched = useCallback(async () => {
    await refresh();
    if (!workdir) return;
    try {
      setBranch(await getRepoBranch(workdir));
    } catch {
      // ignore
    }
  }, [refresh, workdir]);

  return (
    <>
      <div className="flex h-full flex-col">
        <main className="flex min-h-0 flex-1 items-center justify-center border-t border-border bg-background">
          {error ? (
            <p className="text-destructive text-sm">{error}</p>
          ) : workdir ? (
            <p className="text-muted-foreground text-sm">Editor coming soon</p>
          ) : (
            <Button onClick={handleOpenClick}>Open Folder</Button>
          )}
        </main>
        {workdir && (
          <StatusBar
            workdir={workdir}
            branch={branch}
            onOpenRepo={openAndRecord}
            onBranchSwitched={handleBranchSwitched}
          />
        )}
      </div>
      <Toaster />
    </>
  );
}

export default App;
