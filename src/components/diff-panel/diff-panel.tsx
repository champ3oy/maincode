import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "next-themes";
import {
  CodeView,
  type CodeViewHandle,
  useWorkerPool,
} from "@pierre/diffs/react";
import {
  DEFAULT_THEMES,
  parseDiffFromFile,
  type AnnotationSide,
  type CodeViewDiffItem,
  type CodeViewFileItem,
  type CodeViewItem,
  type CodeViewOptions,
  type DiffLineAnnotation,
  type FileDiffMetadata,
  type SelectedLineRange,
} from "@pierre/diffs";

import { DiffToolbar } from "./diff-toolbar";
import { getAnnotationTarget } from "./annotation-target";
import { CommentForm } from "@/components/comments/comment-form";
import { CommentBubble } from "@/components/comments/comment-bubble";
import { cn } from "@/lib/utils";
import { IconChevronDown } from "@tabler/icons-react";
import { perfLog } from "@/lib/perf";
import {
  FILE_STATUS,
  DIFF_ADDITION_COLOR,
  DIFF_DELETION_COLOR,
} from "@/lib/status";
import {
  resolveFontFamily,
  resolveLineHeight,
  useDiffSettings,
} from "@/hooks/use-diff-settings";
import type { ChangeKind, FileEntry } from "@/lib/tauri";
import type { FileDiffContents } from "@/hooks/use-diffs";
import type { ActionType, CommentMetadata } from "@/types/comments";

type Item = CodeViewItem<CommentMetadata>;

interface DiffPanelProps {
  files: FileEntry[];
  diffs: Map<string, FileDiffContents>;
  loading: boolean;
  diffStyle: "unified" | "split";
  onDiffStyleChange: (style: "unified" | "split") => void;
  allExpanded: boolean;
  onToggleExpandAll: () => void;
  scrollToPath: string | null;
  scrollNonce: number;
  annotationsByFile: Map<string, DiffLineAnnotation<CommentMetadata>[]>;
  hasOpenForm: boolean;
  totalCommentCount: number;
  pendingCount: number;
  acknowledgedCount: number;
  resolvedCount: number;
  onAddAnnotation: (
    filePath: string,
    side: AnnotationSide,
    lineStart: number,
    lineEnd: number,
  ) => void;
  onCancelAnnotation: (
    filePath: string,
    side: AnnotationSide,
    lineNumber: number,
  ) => void;
  onSubmitAnnotation: (
    filePath: string,
    side: AnnotationSide,
    lineNumber: number,
    text: string,
    actionType: ActionType,
  ) => void;
  onDeleteAnnotation: (
    filePath: string,
    side: AnnotationSide,
    lineNumber: number,
  ) => void;
  onSubmitReview: () => void;
  onClearResolved: () => void;
  submittingReview: boolean;
  branchInfo?: {
    baseRef: string;
    additions: number;
    deletions: number;
    onBack: () => void;
  };
  workingChangesNotice?: {
    count: number;
    onBack: () => void;
  };
}

const EMPTY_ANNOTATIONS: DiffLineAnnotation<CommentMetadata>[] = [];

function getBinaryDiffMessage(
  kind: ChangeKind,
  oldBinary: boolean,
  newBinary: boolean,
): string {
  if (kind === "added") return "Binary file added. Text diff unavailable.";
  if (kind === "deleted") return "Binary file deleted. Text diff unavailable.";
  if (!oldBinary && newBinary) {
    return "File now contains binary data. Text diff unavailable.";
  }
  if (oldBinary && !newBinary) {
    return "Previous version is binary. Text diff unavailable.";
  }
  return "Binary file changed. Text diff unavailable.";
}

// Gate CodeView mounting on workers having finished theme + language setup.
// Without this, items briefly render unhighlighted and the parent background
// shows through during fast scroll repaints (black flashes on dark theme).
// `workersFailed` is treated as terminal: managerState stays at "waiting" when
// initialization rejects, so without this branch the UI would be stuck on the
// "Initializing…" placeholder forever. Render unhighlighted instead.
// Mirrors pierre's diffshub `useIsWorkerPoolReadyOrDisabled` pattern.
function useIsWorkerPoolReady(): boolean {
  const workerPool = useWorkerPool();
  const [isReady, setIsReady] = useState(
    () => workerPool?.isInitialized() ?? true,
  );
  const isReadyRef = useRef(isReady);
  isReadyRef.current = isReady;
  useEffect(() => {
    if (workerPool == null) {
      if (!isReadyRef.current) setIsReady(true);
      return;
    }
    return workerPool.subscribeToStatChanges((stats) => {
      const next =
        stats.managerState === "initialized" || stats.workersFailed;
      if (next !== isReadyRef.current) {
        isReadyRef.current = next;
        setIsReady(next);
      }
    });
  }, [workerPool]);
  return isReady;
}

export function DiffPanel({
  files,
  diffs,
  loading,
  diffStyle,
  onDiffStyleChange,
  allExpanded,
  onToggleExpandAll,
  scrollToPath,
  scrollNonce,
  annotationsByFile,
  hasOpenForm,
  totalCommentCount,
  pendingCount,
  acknowledgedCount,
  resolvedCount,
  onAddAnnotation,
  onCancelAnnotation,
  onSubmitAnnotation,
  onDeleteAnnotation,
  onSubmitReview,
  onClearResolved,
  submittingReview,
  branchInfo,
  workingChangesNotice,
}: DiffPanelProps) {
  const { resolvedTheme } = useTheme();
  const themeType: "light" | "dark" =
    resolvedTheme === "dark" ? "dark" : "light";
  const { settings } = useDiffSettings();
  const { font, fontSize, wrap } = settings;
  const workerPoolReady = useIsWorkerPoolReady();

  const viewerRef = useRef<CodeViewHandle<CommentMetadata> | null>(null);

  // Tracks the last scrollNonce we successfully delivered to the viewer.
  // The scroll effect bails when the viewer is not yet mounted (workers still
  // initializing, or mid-remount on a viewerKey change); recording the last
  // consumed nonce lets the effect retry once those preconditions flip without
  // replaying a stale scroll on later, unrelated dep changes.
  const lastScrollNonceRef = useRef<number | null>(null);

  // Per-id version counter and last-seen prop snapshots used by the
  // imperative sync effects. Reset on viewerKey change (i.e. CodeView
  // remount) so the next batch of updateItem calls starts cleanly.
  const versionsRef = useRef<Map<string, number>>(new Map());
  const lastAnnotationsRef = useRef<
    Map<string, DiffLineAnnotation<CommentMetadata>[]>
  >(new Map());
  const lastDiffsRef = useRef<Map<string, FileDiffContents>>(new Map());

  // Caches that survive remounts.
  const parseCacheRef = useRef<WeakMap<FileDiffContents, FileDiffMetadata>>(
    new WeakMap(),
  );

  // Lookup for header chrome rendering.
  const fileMetaByPath = useMemo(() => {
    const map = new Map<string, FileEntry>();
    for (const f of files) map.set(f.path, f);
    return map;
  }, [files]);

  // Fingerprints the visible file-path *set + kind* so CodeView remounts
  // when entries are added/removed or flip between text/binary. Per-file
  // content, annotation, and collapse mutations flow through updateItem
  // and keep the same key.
  const viewerKey = useMemo(() => {
    const parts: string[] = [];
    for (const file of files) {
      const contents = diffs.get(file.path);
      if (!contents) continue;
      parts.push(`${file.path}:${contents.kind}`);
    }
    return parts.join("\0");
  }, [files, diffs]);

  // Reset trackers exactly when the viewerKey changes. Running in render is
  // safe because we only touch refs the rest of the component owns.
  const previousViewerKeyRef = useRef<string | null>(null);
  if (previousViewerKeyRef.current !== viewerKey) {
    previousViewerKeyRef.current = viewerKey;
    versionsRef.current = new Map();
    lastAnnotationsRef.current = new Map(annotationsByFile);
    lastDiffsRef.current = new Map(diffs);
  }

  // Build seed items from the current diffs/annotations/expanded state. The
  // resulting array is only consumed by CodeView at first mount; after that,
  // updates flow through viewer.updateItem in the sync effects below.
  const initialItems = useMemo<Item[]>(() => {
    const start = performance.now();
    const cache = parseCacheRef.current;
    const collapsed = !allExpanded;
    const items: Item[] = [];
    let cacheHits = 0;
    let cacheMisses = 0;
    let binary = 0;
    for (const file of files) {
      const contents = diffs.get(file.path);
      if (!contents) continue;
      const annotations =
        annotationsByFile.get(file.path) ?? EMPTY_ANNOTATIONS;

      if (contents.kind === "binary") {
        binary += 1;
        const fileItem: CodeViewFileItem<CommentMetadata> = {
          id: file.path,
          type: "file",
          file: {
            name: file.path,
            contents: getBinaryDiffMessage(
              file.kind,
              contents.oldBinary,
              contents.newBinary,
            ),
            lang: "text",
          },
          // CodeViewFileItem only allows LineAnnotation[]; binary placeholders
          // never carry comments.
          annotations: [],
          collapsed,
          version: 1,
        };
        items.push(fileItem);
        continue;
      }

      let parsed = cache.get(contents);
      if (parsed) {
        cacheHits += 1;
      } else {
        parsed = parseDiffFromFile(contents.oldFile, contents.newFile);
        cache.set(contents, parsed);
        cacheMisses += 1;
      }
      const diffItem: CodeViewDiffItem<CommentMetadata> = {
        id: file.path,
        type: "diff",
        fileDiff: parsed,
        annotations,
        collapsed,
        version: 1,
      };
      items.push(diffItem);
    }
    perfLog("DiffPanel", "buildInitialItems", {
      totalFiles: files.length,
      produced: items.length,
      cacheHits,
      cacheMisses,
      binary,
      ms: +(performance.now() - start).toFixed(2),
    });
    return items;
  }, [files, diffs, annotationsByFile, allExpanded]);

  const bumpVersion = useCallback((id: string): number => {
    const next = (versionsRef.current.get(id) ?? 1) + 1;
    versionsRef.current.set(id, next);
    return next;
  }, []);

  // ── Sync per-file diff contents into existing items ──────────────
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const cache = parseCacheRef.current;
    const prev = lastDiffsRef.current;
    for (const [path, contents] of diffs) {
      if (prev.get(path) === contents) continue;
      const item = viewer.getItem(path);
      if (!item) continue;
      if (contents.kind === "binary") {
        if (item.type !== "file") continue; // type swap → viewerKey remount
        const meta = fileMetaByPath.get(path);
        if (!meta) continue;
        const updated: CodeViewFileItem<CommentMetadata> = {
          ...item,
          file: {
            name: path,
            contents: getBinaryDiffMessage(
              meta.kind,
              contents.oldBinary,
              contents.newBinary,
            ),
            lang: "text",
          },
          version: bumpVersion(path),
        };
        viewer.updateItem(updated);
      } else {
        if (item.type !== "diff") continue;
        let parsed = cache.get(contents);
        if (!parsed) {
          parsed = parseDiffFromFile(contents.oldFile, contents.newFile);
          cache.set(contents, parsed);
        }
        const updated: CodeViewDiffItem<CommentMetadata> = {
          ...item,
          fileDiff: parsed,
          version: bumpVersion(path),
        };
        viewer.updateItem(updated);
      }
    }
    lastDiffsRef.current = new Map(diffs);
  }, [diffs, fileMetaByPath, bumpVersion]);

  // ── Sync annotations into items ──────────────────────────────────
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const prev = lastAnnotationsRef.current;
    for (const [path, annotations] of annotationsByFile) {
      if (prev.get(path) === annotations) continue;
      const item = viewer.getItem(path);
      if (!item || item.type !== "diff") continue;
      const updated: CodeViewDiffItem<CommentMetadata> = {
        ...item,
        annotations,
        version: bumpVersion(path),
      };
      viewer.updateItem(updated);
    }
    for (const path of prev.keys()) {
      if (annotationsByFile.has(path)) continue;
      const item = viewer.getItem(path);
      if (!item || item.type !== "diff") continue;
      if (!item.annotations || item.annotations.length === 0) continue;
      const updated: CodeViewDiffItem<CommentMetadata> = {
        ...item,
        annotations: [],
        version: bumpVersion(path),
      };
      viewer.updateItem(updated);
    }
    lastAnnotationsRef.current = new Map(annotationsByFile);
  }, [annotationsByFile, bumpVersion]);

  // ── Sync allExpanded toggle into items ───────────────────────────
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const wantCollapsed = !allExpanded;
    for (const file of files) {
      const item = viewer.getItem(file.path);
      if (!item) continue;
      if ((item.collapsed ?? false) === wantCollapsed) continue;
      viewer.updateItem({
        ...item,
        collapsed: wantCollapsed,
        version: bumpVersion(file.path),
      } as Item);
    }
  }, [allExpanded, files, bumpVersion]);

  // ── Scroll to file ───────────────────────────────────────────────
  useEffect(() => {
    if (!scrollToPath) return;
    if (lastScrollNonceRef.current === scrollNonce) return;
    const viewer = viewerRef.current;
    if (!viewer) return;
    const item = viewer.getItem(scrollToPath);
    if (!item) return;
    lastScrollNonceRef.current = scrollNonce;
    if (item.collapsed) {
      viewer.updateItem({
        ...item,
        collapsed: false,
        version: bumpVersion(scrollToPath),
      } as Item);
    }
    viewer.scrollTo({
      type: "item",
      id: scrollToPath,
      align: "start",
      behavior: "smooth",
    });
    // workerPoolReady + viewerKey re-fire the effect after CodeView mounts or
    // remounts so a scroll request issued during initialization isn't lost.
  }, [scrollToPath, scrollNonce, bumpVersion, workerPoolReady, viewerKey]);

  // ── Renderers ────────────────────────────────────────────────────

  const toggleCollapsed = useCallback(
    (item: Item) => {
      const viewer = viewerRef.current;
      if (!viewer) return;
      viewer.updateItem({
        ...item,
        collapsed: !item.collapsed,
        version: bumpVersion(item.id),
      } as Item);
    },
    [bumpVersion],
  );

  const renderCustomHeader = useCallback(
    (item: Item) => {
      const meta = fileMetaByPath.get(item.id);
      const parts = item.id.split("/");
      const filename = parts.pop() ?? item.id;
      const dir = parts.length > 0 ? parts.join("/") + "/" : "";
      const status = meta ? FILE_STATUS[meta.kind] : undefined;
      return (
        <button
          type="button"
          onClick={() => toggleCollapsed(item)}
          className="flex w-full cursor-pointer items-start gap-2.5 border-b border-border/50 bg-background px-4 py-2.5 text-left transition-colors hover:bg-muted/40"
          aria-label={item.collapsed ? "Expand file" : "Collapse file"}
        >
          <IconChevronDown
            className={cn(
              "mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform",
              item.collapsed && "-rotate-90",
            )}
          />
          <div className="min-w-0 flex-1">
            <p
              className={cn(
                "truncate text-sm font-medium",
                status?.color ?? "text-foreground",
              )}
            >
              {filename}
            </p>
            {dir && (
              <p className="truncate text-xs text-muted-foreground">{dir}</p>
            )}
          </div>
          {meta && (meta.additions > 0 || meta.deletions > 0) && (
            <div className="flex shrink-0 items-center gap-1.5 text-xs tabular-nums">
              {meta.additions > 0 && (
                <span className={DIFF_ADDITION_COLOR}>+{meta.additions}</span>
              )}
              {meta.deletions > 0 && (
                <span className={DIFF_DELETION_COLOR}>-{meta.deletions}</span>
              )}
            </div>
          )}
        </button>
      );
    },
    [fileMetaByPath, toggleCollapsed],
  );

  const renderAnnotation = useCallback(
    (
      annotation:
        | DiffLineAnnotation<CommentMetadata>
        | { lineNumber: number; metadata?: CommentMetadata | undefined },
    ) => {
      const meta = (annotation as DiffLineAnnotation<CommentMetadata>).metadata;
      if (!meta) return null;
      if (meta.status === "draft" && !meta.text) {
        return (
          <CommentForm
            onSubmit={(text, actionType) =>
              onSubmitAnnotation(
                meta.filePath,
                meta.side,
                meta.lineEnd,
                text,
                actionType,
              )
            }
            onCancel={() =>
              onCancelAnnotation(meta.filePath, meta.side, meta.lineEnd)
            }
          />
        );
      }
      return (
        <CommentBubble
          text={meta.text!}
          actionType={meta.actionType!}
          status={meta.status}
          summary={meta.summary}
          dismissReason={meta.dismissReason}
          onDelete={() =>
            onDeleteAnnotation(meta.filePath, meta.side, meta.lineEnd)
          }
        />
      );
    },
    [onSubmitAnnotation, onCancelAnnotation, onDeleteAnnotation],
  );

  // ── CodeView style + options ─────────────────────────────────────

  const codeViewStyle = useMemo<React.CSSProperties>(
    () =>
      ({
        "--diffs-font-family": resolveFontFamily(font),
        "--diffs-font-size": `${fontSize}px`,
        "--diffs-line-height": `${resolveLineHeight(fontSize)}px`,
      }) as React.CSSProperties,
    [font, fontSize],
  );

  const addAnnotationForRange = useCallback(
    (range: SelectedLineRange, id: string) => {
      const target = getAnnotationTarget(range);
      onAddAnnotation(id, target.side, target.lineStart, target.lineEnd);
    },
    [onAddAnnotation],
  );

  const options = useMemo<CodeViewOptions<CommentMetadata>>(() => {
    type DiffCtx = { item: { type: "diff" | "file"; id: string } };
    const handleSelectionEnd = (
      range: SelectedLineRange | null,
      ctx: DiffCtx,
    ) => {
      if (range == null || ctx.item.type !== "diff") return;
      addAnnotationForRange(range, ctx.item.id);
    };
    const handleGutterClick = (range: SelectedLineRange, ctx: DiffCtx) => {
      if (ctx.item.type !== "diff") return;
      addAnnotationForRange(range, ctx.item.id);
    };
    return {
      theme: DEFAULT_THEMES,
      themeType,
      diffStyle,
      // `scroll` is the safe default. `wrap` mode runs an O(N) per-line
      // getBoundingClientRect pass on every render (see
      // VirtualizedFileDiff.js reconcileHeights), which collapses paint
      // timing on files with ultra-long lines (minified bundles) and shows
      // the parent background as a black flash during fast scroll. Users
      // who want wrap (typical for prose / markdown) opt in via Settings.
      overflow: wrap ? "wrap" : "scroll",
      lineDiffType: "word-alt",
      expansionLineCount: 5,
      hunkSeparators: "line-info",
      stickyHeaders: true,
      layout: { paddingTop: 0, paddingBottom: 0, gap: 1 },
      enableLineSelection: !hasOpenForm,
      enableGutterUtility: !hasOpenForm,
      onLineSelectionEnd:
        handleSelectionEnd as CodeViewOptions<CommentMetadata>["onLineSelectionEnd"],
      onGutterUtilityClick:
        handleGutterClick as CodeViewOptions<CommentMetadata>["onGutterUtilityClick"],
    };
  }, [addAnnotationForRange, diffStyle, hasOpenForm, themeType, wrap]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading diffs...</p>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full min-w-0 flex-col overflow-hidden overscroll-contain bg-background [contain:strict]">
      {workingChangesNotice && workingChangesNotice.count > 0 && (
        <button
          type="button"
          onClick={workingChangesNotice.onBack}
          className="flex h-7 shrink-0 items-center gap-2 border-b border-border bg-muted/40 px-3 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
        >
          <span className="truncate">
            {workingChangesNotice.count} working change
            {workingChangesNotice.count === 1 ? "" : "s"} waiting
          </span>
          <span className="ml-auto shrink-0 text-foreground">
            Back to changes
          </span>
        </button>
      )}
      {(initialItems.length > 0 || branchInfo) && (
        <DiffToolbar
          diffStyle={diffStyle}
          onDiffStyleChange={onDiffStyleChange}
          allExpanded={allExpanded}
          onToggleExpandAll={onToggleExpandAll}
          commentCount={totalCommentCount}
          pendingCount={pendingCount}
          acknowledgedCount={acknowledgedCount}
          resolvedCount={resolvedCount}
          onSubmitReview={onSubmitReview}
          onClearResolved={onClearResolved}
          submittingReview={submittingReview}
          branchInfo={branchInfo}
        />
      )}
      {initialItems.length === 0 ? (
        <div className="flex h-full items-center justify-center">
          <p className="text-sm text-muted-foreground">
            {branchInfo
              ? `No changes since ${branchInfo.baseRef}`
              : "No changes to review"}
          </p>
        </div>
      ) : !workerPoolReady ? (
        <div className="flex h-full items-center justify-center">
          <p className="text-sm text-muted-foreground">Initializing…</p>
        </div>
      ) : (
        <CodeView<CommentMetadata>
          key={viewerKey}
          ref={viewerRef}
          initialItems={initialItems}
          options={options}
          className="relative min-h-0 min-w-0 w-full flex-1 overflow-y-auto overflow-x-clip overscroll-contain [contain:strict] [overflow-anchor:none] [will-change:scroll-position] [&_diffs-container]:overflow-clip [&_diffs-container]:[contain:layout_paint_style] [&_diffs-container]:shadow-[0_-1px_0_var(--color-border),0_1px_0_var(--color-border)]"
          style={codeViewStyle}
          renderCustomHeader={renderCustomHeader}
          renderAnnotation={renderAnnotation}
        />
      )}
    </div>
  );
}
