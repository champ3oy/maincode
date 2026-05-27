import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { Toaster } from "@/components/ui/sonner";
import { Sidebar } from "@/components/sidebar/sidebar";
import { DiffPanel } from "@/components/diff-panel/diff-panel";
import { Onboarding } from "@/components/onboarding/onboarding";
import { StatusBar } from "@/components/status-bar/status-bar";
import {
  clearLastOpenedRepo,
  readLastOpenedRepo,
  useRepoStatus,
} from "@/hooks/use-repo-status";
import { useDiffs } from "@/hooks/use-diffs";
import { useBranchDiff } from "@/hooks/use-branch-diff";
import { useComments } from "@/hooks/use-comments";
import { useRecentRepos } from "@/hooks/use-recent-repos";
import { useCommitDiff } from "@/hooks/use-commit-diff";
import { useCommitDetailsCache } from "@/hooks/use-commit-details-cache";
import { CommitDetailHeader } from "@/components/commit-detail/commit-detail-header";
import { ask } from "@tauri-apps/plugin-dialog";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import {
  stageFile,
  unstageFile,
  stageAll,
  unstageAll,
  commit,
  submitReview,
  discardFile,
  getLaunchPath,
  getRepoBranch,
  type CommitOptions,
  type FileEntry,
} from "@/lib/tauri";
import { toast } from "sonner";
import { listen } from "@tauri-apps/api/event";
import type { CommentStatus } from "@/types/comments";
import { perfLog } from "@/lib/perf";

interface CommentStatusPayload {
  review_id: string;
  comment_id: string;
  status: CommentStatus;
  summary: string | null;
  dismiss_reason: string | null;
}

function App() {
  const { workdir, status, error, refresh, open, close } = useRepoStatus();
  const { addRecent } = useRecentRepos();
  const { diffs, loading } = useDiffs(status?.staged, status?.unstaged);
  const comments = useComments();
  const [diffStyle, setDiffStyle] = useState<"unified" | "split">("split");
  const [allExpanded, setAllExpanded] = useState(true);
  const [scrollToPath, setScrollToPath] = useState<string | null>(null);
  const [scrollNonce, setScrollNonce] = useState(0);
  const [submittingReview, setSubmittingReview] = useState(false);
  const [branchDiffActive, setBranchDiffActive] = useState(false);
  const branchDiff = useBranchDiff(branchDiffActive, workdir);
  const [tab, setTab] = useState<"changes" | "history">("changes");
  const [selectedCommitOid, setSelectedCommitOid] = useState<string | null>(null);

  useEffect(() => {
    setBranchDiffActive(false);
    setTab("changes");
    setSelectedCommitOid(null);
  }, [workdir]);

  useEffect(() => {
    if (tab !== "history") setSelectedCommitOid(null);
  }, [tab]);

  const historyActive = tab === "history" && !branchDiffActive;
  const commitDiff = useCommitDiff(historyActive ? selectedCommitOid : null);
  const { cache, requestVisible } = useCommitDetailsCache();

  useEffect(() => {
    if (historyActive && selectedCommitOid) requestVisible([selectedCommitOid]);
  }, [historyActive, selectedCommitOid, requestVisible]);

  useEffect(() => {
    if (!branchDiffActive || !branchDiff.resolved) return;
    if (branchDiff.error) {
      toast.error(`Branch diff failed: ${branchDiff.error}`);
      setBranchDiffActive(false);
      return;
    }
    if (!branchDiff.meta) {
      toast.error("No base branch found (tried origin/HEAD, main, master, trunk)");
      setBranchDiffActive(false);
    }
  }, [branchDiffActive, branchDiff.resolved, branchDiff.error, branchDiff.meta]);
  const [optimisticStage, setOptimisticStage] = useState<Map<string, boolean>>(
    new Map(),
  );
  const restoreOpenStartedRef = useRef(false);
  const [branch, setBranch] = useState<string | null>(null);

  // TODO: set `plugins.updater.pubkey` in src-tauri/tauri.conf.json before release.
  // Until then, check() throws on the placeholder key and the .catch below swallows it.
  // App runs normally; only auto-update is disabled.
  useEffect(() => {
    let cancelled = false;
    check()
      .then((update) => {
        if (cancelled || !update) return;
        toast.info(`Update ${update.version} available`, {
          description: update.body ?? undefined,
          action: {
            label: "Install and relaunch",
            onClick: async () => {
              const toastId = toast.loading(`Installing ${update.version}...`);
              try {
                await update.downloadAndInstall();
                toast.success("Update installed. Relaunching...", { id: toastId });
                await relaunch();
              } catch (e) {
                toast.error(`Update install failed: ${e}`, { id: toastId });
              }
            },
          },
        });
      })
      .catch((e) => console.error("[cub] update check failed:", e));
    return () => {
      cancelled = true;
    };
  }, []);


  // Listen for real-time comment status updates from the Tauri event bridge
  const { updateCommentStatus } = comments;
  useEffect(() => {
    const promise = listen<CommentStatusPayload>(
      "review:comment-updated",
      (event) => {
        updateCommentStatus(
          event.payload.comment_id,
          event.payload.status,
          event.payload.summary,
          event.payload.dismiss_reason,
        );
      },
    );
    return () => {
      promise.then((unlisten) => unlisten());
    };
  }, [updateCommentStatus]);

  // Keep a latest-ref for the repo:changed callback so the Tauri subscription
  // doesn't tear down + re-attach every time `loading` or comment counts
  // change (which would drop fs events landing during re-subscribe).
  const repoChangedRef = useRef<() => void>(() => {});
  useEffect(() => {
    repoChangedRef.current = () => {
      if (!workdir) {
        perfLog("App", "fileWatcher:skip", { reason: "no-workdir" });
        return;
      }
      if (loading) {
        perfLog("App", "fileWatcher:skip", { reason: "diffs-loading" });
        return;
      }
      if (comments.totalCommentCount === 0) {
        perfLog("App", "fileWatcher:tick");
        refresh();
      } else {
        perfLog("App", "fileWatcher:skip", {
          reason: "open-comments",
          totalCommentCount: comments.totalCommentCount,
        });
      }
    };
  });
  useEffect(() => {
    if (!workdir) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    listen("repo:changed", () => repoChangedRef.current()).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [workdir]);

  useEffect(() => {
    if (!status) return;
    perfLog("App", "status:apply", {
      staged: status.staged.length,
      unstaged: status.unstaged.length,
      total: status.staged.length + status.unstaged.length,
    });
  }, [status]);

  // Refresh the displayed branch whenever the repo opens or status reloads
  // (which fires after stage/commit/checkout via the file watcher).
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
      .catch((e) => console.error("[cub] getRepoBranch failed:", e));
    return () => {
      cancelled = true;
    };
  }, [workdir, status]);

  useEffect(() => {
    perfLog("App", "diffs:change", {
      diffCount: diffs.size,
      loading,
    });
  }, [diffs, loading]);

  useEffect(() => {
    perfLog("App", "allExpanded:change", { allExpanded });
  }, [allExpanded]);

  // Apply optimistic stage toggles to the raw staged/unstaged lists so the
  // sidebar sections reshuffle instantly without waiting for the backend.
  const { stagedView, unstagedView } = useMemo(() => {
    if (!status)
      return { stagedView: [] as FileEntry[], unstagedView: [] as FileEntry[] };
    if (optimisticStage.size === 0) {
      return { stagedView: status.staged, unstagedView: status.unstaged };
    }
    const stagedByPath = new Map(status.staged.map((f) => [f.path, f]));
    const unstagedByPath = new Map(status.unstaged.map((f) => [f.path, f]));
    const nextStaged = new Map(stagedByPath);
    const nextUnstaged = new Map(unstagedByPath);
    optimisticStage.forEach((wantStaged, path) => {
      const source = stagedByPath.get(path) ?? unstagedByPath.get(path);
      if (!source) return;
      if (wantStaged) {
        nextStaged.set(path, source);
        nextUnstaged.delete(path);
      } else {
        nextUnstaged.set(path, source);
        nextStaged.delete(path);
      }
    });
    return {
      stagedView: Array.from(nextStaged.values()),
      unstagedView: Array.from(nextUnstaged.values()),
    };
  }, [status, optimisticStage]);

  const stagedPaths = useMemo(
    () => new Set(stagedView.map((f) => f.path)),
    [stagedView],
  );

  const allFiles = useMemo((): FileEntry[] => {
    if (!status) return [];
    const seen = new Set<string>();
    const files: FileEntry[] = [];
    for (const f of status.staged) {
      if (!seen.has(f.path)) {
        seen.add(f.path);
        files.push(f);
      }
    }
    for (const f of status.unstaged) {
      if (!seen.has(f.path)) {
        seen.add(f.path);
        files.push(f);
      }
    }
    return files;
  }, [status]);

  const branchDiffTotals = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    for (const f of branchDiff.files) {
      additions += f.additions;
      deletions += f.deletions;
    }
    return { additions, deletions };
  }, [branchDiff.files]);

  const handleToggleExpandAll = useCallback(() => {
    setAllExpanded((v) => !v);
  }, []);

  const handleSelectFile = useCallback((path: string) => {
    setScrollToPath(path);
    setScrollNonce((n) => n + 1);
  }, []);


  const stagedPathsRef = useRef(stagedPaths);
  stagedPathsRef.current = stagedPaths;

  const handleToggleStage = useCallback(
    async (path: string) => {
      const willStage = !stagedPathsRef.current.has(path);
      setOptimisticStage((prev) => {
        const next = new Map(prev);
        next.set(path, willStage);
        return next;
      });
      try {
        if (willStage) {
          await stageFile(path);
        } else {
          await unstageFile(path);
        }
        await refresh();
      } catch (e) {
        toast.error(`Stage failed: ${e}`);
      } finally {
        setOptimisticStage((prev) => {
          if (!prev.has(path)) return prev;
          const next = new Map(prev);
          next.delete(path);
          return next;
        });
      }
    },
    [refresh],
  );

  const handleStageAll = useCallback(async () => {
    const paths = unstagedView.map((f) => f.path);
    if (paths.length === 0) return;
    setOptimisticStage((prev) => {
      const next = new Map(prev);
      for (const path of paths) next.set(path, true);
      return next;
    });

    try {
      await stageAll();
      await refresh();
    } catch (e) {
      toast.error(`Stage all failed: ${e}`);
    } finally {
      setOptimisticStage((prev) => {
        let changed = false;
        const next = new Map(prev);
        for (const path of paths) {
          changed = next.delete(path) || changed;
        }
        return changed ? next : prev;
      });
    }
  }, [refresh, unstagedView]);

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

  const { collectAllComments, markSubmitted } = comments;
  const submittingRef = useRef(false);

  const handleSubmitReview = useCallback(async () => {
    if (submittingRef.current) return;
    const reviewComments = collectAllComments();
    if (reviewComments.length === 0) return;

    submittingRef.current = true;
    setSubmittingReview(true);
    try {
      const result = await submitReview(reviewComments);
      toast.success(`Submitted ${result.submitted_count} comment(s)`);
      // Map server IDs back to local annotations by key
      const idMap = new Map(result.comment_ids.map((m) => [m.key, m.id]));
      markSubmitted(idMap);
    } catch (e) {
      toast.error(`Review submit failed: ${e}`);
    } finally {
      submittingRef.current = false;
      setSubmittingReview(false);
    }
  }, [collectAllComments, markSubmitted]);

  const handleBranchSwitched = useCallback(async () => {
    await refresh();
    if (!workdir) return;
    try {
      const b = await getRepoBranch(workdir);
      setBranch(b);
    } catch (e) {
      console.error("[cub] getRepoBranch failed after switch:", e);
    }
  }, [refresh, workdir]);

  const handleTabChange = useCallback(
    (next: "changes" | "history") => {
      if (branchDiffActive) {
        setBranchDiffActive(false);
      }
      setTab(next);
    },
    [branchDiffActive],
  );

  // Honor `cub [path]` first; otherwise restore the last successfully opened repo.
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
  useEffect(() => {
    let cancelled = false;
    getLaunchPath()
      .then((launchPath) => {
        if (cancelled) return;
        const restorePath = launchPath ?? readLastOpenedRepo();
        if (!restorePath || restoreOpenStartedRef.current) return;
        restoreOpenStartedRef.current = true;
        perfLog("App", "open:restore", {
          source: launchPath ? "launchPath" : "lastOpened",
          path: restorePath,
        });
        openRef.current(restorePath).catch((e) => {
          if (!launchPath) clearLastOpenedRepo();
          toast.error(`Failed to open: ${e}`);
        });
      })
      .catch((e) => console.error("[cub] getLaunchPath failed:", e));
    return () => {
      cancelled = true;
    };
  }, []);

  if (!workdir) {
    return (
      <>
        <Onboarding onOpened={openAndRecord} />
        <Toaster />
      </>
    );
  }

  if (error) {
    return (
      <main className="flex h-dvh items-center justify-center p-4">
        <p className="text-destructive text-sm">{error}</p>
      </main>
    );
  }

  if (!status) {
    return (
      <main className="flex h-dvh items-center justify-center">
        <p className="text-muted-foreground text-sm">Loading...</p>
      </main>
    );
  }

  const diffPanelFiles = historyActive
    ? commitDiff.files
    : branchDiffActive
      ? branchDiff.files
      : allFiles;
  const diffPanelDiffs = historyActive
    ? commitDiff.diffs
    : branchDiffActive
      ? branchDiff.diffs
      : diffs;
  const diffPanelLoading = historyActive
    ? commitDiff.loading
    : branchDiffActive
      ? branchDiff.loading
      : loading;
  const workingChangesCount =
    (status?.staged.length ?? 0) + (status?.unstaged.length ?? 0);
  const branchInfo =
    branchDiffActive && branchDiff.meta
      ? {
          baseRef: branchDiff.meta.base_ref,
          additions: branchDiffTotals.additions,
          deletions: branchDiffTotals.deletions,
          onBack: () => setBranchDiffActive(false),
        }
      : undefined;
  const workingChangesNotice =
    branchDiffActive && workingChangesCount > 0
      ? { count: workingChangesCount, onBack: () => setBranchDiffActive(false) }
      : undefined;
  const commitDetailHeader =
    historyActive && selectedCommitOid ? (
      <CommitDetailHeader
        details={cache.get(selectedCommitOid)}
        oid={selectedCommitOid}
      />
    ) : undefined;

  return (
    <>
      <div className="flex h-full flex-col">
      <ResizablePanelGroup
        orientation="horizontal"
        className="flex-1 min-h-0 isolate border-t border-border bg-background"
      >
        <ResizablePanel defaultSize="25%" minSize={300} maxSize={400}>
          {branchDiffActive ? (
            <Sidebar
              mode="branch"
              workdir={workdir}
              branchFiles={branchDiff.files}
              baseRef={branchDiff.meta?.base_ref ?? ""}
              selectedFile={scrollToPath}
              onSelectFile={handleSelectFile}
              onCloseRepo={close}
              tab={tab}
              tabsDisabled
              hasUncommittedChanges={workingChangesCount > 0}
              onTabChange={handleTabChange}
            />
          ) : tab === "history" ? (
            <Sidebar
              mode="history"
              workdir={workdir}
              selectedOid={selectedCommitOid}
              onSelectOid={setSelectedCommitOid}
              onCloseRepo={close}
              tab={tab}
              hasUncommittedChanges={workingChangesCount > 0}
              onTabChange={handleTabChange}
            />
          ) : (
            <Sidebar
              mode="working"
              workdir={workdir}
              staged={stagedView}
              unstaged={unstagedView}
              stagedPaths={stagedPaths}
              selectedFile={scrollToPath}
              onSelectFile={handleSelectFile}
              onToggleStage={handleToggleStage}
              onStageAll={handleStageAll}
              onUnstageAll={handleUnstageAll}
              onCommit={handleCommit}
              onCloseRepo={close}
              onDiscardFile={handleDiscardFile}
              onViewBranchDiff={() => setBranchDiffActive(true)}
              tab={tab}
              hasUncommittedChanges={workingChangesCount > 0}
              onTabChange={handleTabChange}
            />
          )}
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel defaultSize="78%">
          <DiffPanel
            files={diffPanelFiles}
            diffs={diffPanelDiffs}
            loading={diffPanelLoading}
            diffStyle={diffStyle}
            onDiffStyleChange={setDiffStyle}
            allExpanded={allExpanded}
            onToggleExpandAll={handleToggleExpandAll}
            scrollToPath={historyActive ? null : scrollToPath}
            scrollNonce={historyActive ? 0 : scrollNonce}
            branchInfo={historyActive ? undefined : branchInfo}
            workingChangesNotice={
              historyActive ? undefined : workingChangesNotice
            }
            readOnly={historyActive}
            commitDetailHeader={commitDetailHeader}
            {...(historyActive
              ? {}
              : {
                  annotationsByFile: comments.annotationsByFile,
                  hasOpenForm: comments.hasOpenForm,
                  totalCommentCount: comments.totalCommentCount,
                  pendingCount: comments.pendingCount,
                  acknowledgedCount: comments.acknowledgedCount,
                  resolvedCount: comments.resolvedCount,
                  onAddAnnotation: comments.addFormAnnotation,
                  onCancelAnnotation: comments.cancelAnnotation,
                  onSubmitAnnotation: comments.submitAnnotation,
                  onDeleteAnnotation: comments.deleteAnnotation,
                  onSubmitReview: handleSubmitReview,
                  onClearResolved: comments.clearResolved,
                  submittingReview: submittingReview,
                })}
          />
        </ResizablePanel>
      </ResizablePanelGroup>
        <StatusBar
          workdir={workdir}
          branch={branch}
          onOpenRepo={openAndRecord}
          onBranchSwitched={handleBranchSwitched}
        />
      </div>
      <Toaster />
    </>
  );
}

export default App;
