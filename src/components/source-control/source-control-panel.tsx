import { useEffect, useMemo, useRef, type CSSProperties } from "react";
import { FileTree, useFileTree, useFileTreeSelection } from "@pierre/trees/react";
import type { GitStatus, GitStatusEntry } from "@pierre/trees";
import { CommitBar } from "@/components/sidebar/commit-bar";
import { ScContextMenu } from "./sc-context-menu";
import type { ChangeKind, CommitOptions, FileEntry } from "@/lib/tauri";
import { perfTimed } from "@/lib/perf";

// ── Helpers ──────────────────────────────────────────────────────────────────

function mapKind(kind: ChangeKind): GitStatus {
  switch (kind) {
    case "added":
      return "added";
    case "deleted":
      return "deleted";
    case "renamed":
      return "renamed";
    case "modified":
    case "typechange":
    default:
      return "modified";
  }
}

const treeStyle: CSSProperties = {
  colorScheme: "dark",
  "--trees-bg-override": "transparent",
  "--trees-fg-override": "var(--foreground)",
  "--trees-fg-muted-override": "var(--muted-foreground)",
  "--trees-bg-muted-override": "var(--muted)",
  "--trees-selected-bg-override": "var(--accent)",
  "--trees-selected-fg-override": "var(--accent-foreground)",
  "--trees-border-color-override": "var(--border)",
  "--trees-padding-inline-override": "6px",
  "--trees-item-margin-x-override": "0px",
  height: "100%",
} as CSSProperties;

// ── Section (one staged or one unstaged tree) ─────────────────────────────────

interface SectionProps {
  label: string;
  files: FileEntry[];
  treeId: string;
  isStaged: boolean;
  actionLabel?: string;
  onAction?: () => void;
  onSelectFile: (path: string) => void;
  onStage?: (path: string) => void;
  onUnstage?: (path: string) => void;
  onDiscard?: (path: string) => void;
}

function Section({
  label,
  files,
  treeId,
  isStaged,
  actionLabel,
  onAction,
  onSelectFile,
  onStage,
  onUnstage,
  onDiscard,
}: SectionProps) {
  const paths = useMemo(() => files.map((f) => f.path), [files]);
  const gitStatus = useMemo<GitStatusEntry[]>(
    () => files.map((f) => ({ path: f.path, status: mapKind(f.kind) })),
    [files],
  );

  const { model } = useFileTree({
    id: treeId,
    paths,
    flattenEmptyDirectories: true,
    initialExpansion: "open",
    gitStatus,
    density: "compact",
    icons: { set: "standard", colored: true },
    composition: {
      contextMenu: {
        enabled: true,
        triggerMode: "right-click",
      },
    },
  });

  // Keep model in sync with external changes
  useEffect(() => {
    perfTimed("SourceControlPanel", "model.resetPaths", () => model.resetPaths(paths), {
      treeId,
      count: paths.length,
    });
  }, [paths, model, treeId]);

  useEffect(() => {
    perfTimed(
      "SourceControlPanel",
      "model.setGitStatus",
      () => model.setGitStatus(gitStatus),
      { treeId, count: gitStatus.length },
    );
  }, [gitStatus, model, treeId]);

  // Layer 1: selection subscription (guards against re-emitting same path)
  const selectedPaths = useFileTreeSelection(model);
  const lastEmittedRef = useRef<string | null>(null);
  useEffect(() => {
    if (selectedPaths.length === 0) {
      lastEmittedRef.current = null;
      return;
    }
    const path = selectedPaths[selectedPaths.length - 1];
    if (path === lastEmittedRef.current) return;
    const item = model.getItem(path);
    if (item == null || item.isDirectory()) return;
    lastEmittedRef.current = path;
    onSelectFile(path);
  }, [selectedPaths, model, onSelectFile]);

  // Layer 2: composed-path DOM click listener (catches re-clicks of already-selected row)
  const treeWrapperRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const wrapper = treeWrapperRef.current;
    if (wrapper == null) return;
    const handleClick = (event: MouseEvent) => {
      for (const el of event.composedPath()) {
        if (!(el instanceof HTMLElement)) continue;
        if (el.dataset.itemType === "file") {
          const itemPath = el.dataset.itemPath;
          if (itemPath) onSelectFile(itemPath);
          return;
        }
      }
    };
    wrapper.addEventListener("click", handleClick);
    return () => wrapper.removeEventListener("click", handleClick);
  }, [onSelectFile]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between px-2 py-1">
        <span className="text-xs font-medium text-muted-foreground">
          {label} <span className="text-[10px]">({files.length})</span>
        </span>
        {actionLabel && onAction && (
          <button
            type="button"
            className="h-5 cursor-pointer rounded px-1.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={onAction}
          >
            {actionLabel}
          </button>
        )}
      </div>
      <div ref={treeWrapperRef} className="min-h-0 flex-1">
        <FileTree
          model={model}
          style={treeStyle}
          renderContextMenu={(item, context) => (
            <ScContextMenu
              item={item}
              context={context}
              isStaged={isStaged}
              onStage={onStage ? (p) => { onStage(p); } : undefined}
              onUnstage={onUnstage ? (p) => { onUnstage(p); } : undefined}
              onDiscard={onDiscard ? (p) => { onDiscard(p); } : undefined}
            />
          )}
        />
      </div>
    </div>
  );
}

// ── SourceControlPanel ────────────────────────────────────────────────────────

interface SourceControlPanelProps {
  staged: FileEntry[];
  unstaged: FileEntry[];
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
  onStage: (path: string) => void;
  onUnstage: (path: string) => void;
  onStageAll: () => void;
  onUnstageAll: () => void;
  onCommit: (message: string, options?: CommitOptions) => void;
  onDiscardFile: (path: string) => void;
}

export function SourceControlPanel({
  staged,
  unstaged,
  onSelectFile,
  onStage,
  onUnstage,
  onStageAll,
  onUnstageAll,
  onCommit,
  onDiscardFile,
}: SourceControlPanelProps) {
  const empty = staged.length === 0 && unstaged.length === 0;

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1 flex-col">
        {empty ? (
          <p className="px-3 py-4 text-xs text-muted-foreground">No changes</p>
        ) : (
          <>
            {staged.length > 0 && (
              <Section
                label="Staged"
                files={staged}
                treeId="sc-staged-tree"
                isStaged={true}
                actionLabel="Unstage All"
                onAction={onUnstageAll}
                onSelectFile={onSelectFile}
                onUnstage={onUnstage}
              />
            )}
            {unstaged.length > 0 && (
              <Section
                label="Changes"
                files={unstaged}
                treeId="sc-unstaged-tree"
                isStaged={false}
                actionLabel="Stage All"
                onAction={onStageAll}
                onSelectFile={onSelectFile}
                onStage={onStage}
                onDiscard={onDiscardFile}
              />
            )}
          </>
        )}
      </div>
      <CommitBar stagedCount={staged.length} onCommit={onCommit} />
    </div>
  );
}
