import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import { FileTree as PierreFileTree, useFileTree, useFileTreeSelection } from "@pierre/trees/react";
import { listen } from "@tauri-apps/api/event";
import { readDir, type DirEntryInfo } from "@/lib/fs";
import { FileTreeContextMenu } from "./file-tree-context-menu";

export type FileOp =
  | { kind: "new-file"; dir: string }
  | { kind: "new-folder"; dir: string }
  | { kind: "rename"; path: string; name: string; isDir: boolean }
  | { kind: "delete"; path: string; name: string; isDir: boolean };

interface FileTreeProps {
  rootPath: string;
  onOpenFile: (path: string) => void;
  onFileOp: (op: FileOp) => void;
  refreshNonce?: number;
}

// `@pierre/trees` builds its tree from the path segments it is given, so the
// paths must be RELATIVE to the workspace root — otherwise an absolute path
// like `/Users/me/proj/src` roots the tree at the filesystem `/` and the whole
// disk becomes browsable. We feed relative model paths (dirs carry a trailing
// slash) and convert back to absolute when calling the backend / opening files.
function normalizeRoot(rootPath: string): string {
  return rootPath.replace(/\/+$/, "");
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

export function FileTree({
  rootPath,
  onOpenFile,
  onFileOp,
  refreshNonce = 0,
}: FileTreeProps) {
  // Kept current every render so the stable helpers below always see the
  // latest root without re-triggering effects.
  const rootRef = useRef(normalizeRoot(rootPath));
  rootRef.current = normalizeRoot(rootPath);

  // absolute fs path -> relative model path (trailing slash for directories)
  const toModelPath = useCallback((e: DirEntryInfo): string => {
    const rel = e.path.slice(rootRef.current.length + 1);
    return e.is_dir ? rel + "/" : rel;
  }, []);
  // relative model path -> absolute fs path (drops any trailing slash)
  const toAbs = useCallback((modelPath: string): string => {
    return `${rootRef.current}/${modelPath.replace(/\/$/, "")}`;
  }, []);

  const [paths, setPaths] = useState<string[]>([]);
  // Absolute fs paths that have been loaded (initial root + expanded dirs).
  const loadedDirs = useRef<Set<string>>(new Set());
  // Relative model-paths (with trailing slash) currently expanded.
  const expandedModelPaths = useRef<Set<string>>(new Set());
  // Last selection path we acted on (dedup guard for the selection effect).
  const lastHandledRef = useRef<string | null>(null);

  const { model } = useFileTree({
    id: "files-browser",
    paths,
    initialExpansion: "closed",
    flattenEmptyDirectories: false,
    density: "compact",
    icons: { set: "standard", colored: true },
    composition: {
      contextMenu: { enabled: true, triggerMode: "right-click" },
    },
  });

  // Sync model when paths change, preserving expansion state
  useEffect(() => {
    model.resetPaths(paths, {
      initialExpandedPaths: [...expandedModelPaths.current],
    });
  }, [paths, model]);

  // Load root directory on mount / rootPath change
  useEffect(() => {
    let cancelled = false;
    const absRoot = normalizeRoot(rootPath);
    loadedDirs.current = new Set();
    expandedModelPaths.current = new Set();
    lastHandledRef.current = null;
    setPaths([]);

    readDir(absRoot)
      .then((entries) => {
        if (cancelled) return;
        loadedDirs.current.add(absRoot);
        setPaths(entries.map(toModelPath));
      })
      .catch(() => {
        // ignore — root dir read failure is handled gracefully (empty tree)
      });

    return () => {
      cancelled = true;
    };
  }, [rootPath, toModelPath]);

  // Refresh: re-read all loaded dirs, rebuild the (relative) paths set
  const refreshLoaded = useCallback(() => {
    const currentLoaded = [...loadedDirs.current];
    Promise.all(
      currentLoaded.map((dir) =>
        readDir(dir).then((entries) => ({ dir, entries })).catch(() => null),
      ),
    ).then((results) => {
      const modelPathSet = new Set<string>();
      for (const result of results) {
        if (!result) continue;
        for (const e of result.entries) {
          modelPathSet.add(toModelPath(e));
        }
      }
      // Keep expandedModelPaths in sync (only keep dirs that still exist)
      const stillExpanded = new Set<string>();
      for (const mp of expandedModelPaths.current) {
        if (modelPathSet.has(mp)) stillExpanded.add(mp);
      }
      expandedModelPaths.current = stillExpanded;
      setPaths([...modelPathSet]);
    });
  }, [toModelPath]);

  // refreshNonce prop: bump to force reload
  const prevNonce = useRef(0);
  useEffect(() => {
    if (refreshNonce > 0 && refreshNonce !== prevNonce.current) {
      prevNonce.current = refreshNonce;
      refreshLoaded();
    }
  }, [refreshNonce, refreshLoaded]);

  // Tauri repo:changed event → refresh
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    listen("repo:changed", () => refreshLoaded()).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [refreshLoaded]);

  // Selection → lazy-load directories / open files
  const selectedPaths = useFileTreeSelection(model);

  useEffect(() => {
    if (selectedPaths.length === 0) return;
    const path = selectedPaths[selectedPaths.length - 1]; // relative model path
    if (path === lastHandledRef.current) return;
    lastHandledRef.current = path;

    const item = model.getItem(path);
    if (!item) return;

    if (!item.isDirectory()) {
      // It's a file — open it (absolute path for the backend)
      onOpenFile(toAbs(path));
      return;
    }

    // It's a directory — absolute fs path for readDir.
    const fsPath = toAbs(path);

    if (loadedDirs.current.has(fsPath)) {
      // Already loaded — track expansion (so resetPaths keeps it open)
      expandedModelPaths.current.add(path);
      return;
    }

    // Lazily load children
    loadedDirs.current.add(fsPath);
    expandedModelPaths.current.add(path);

    readDir(fsPath)
      .then((entries) => {
        model.batch(
          entries.map((e) => ({ type: "add" as const, path: toModelPath(e) })),
        );
      })
      .catch(() => {
        // Allow retry on error
        loadedDirs.current.delete(fsPath);
        expandedModelPaths.current.delete(path);
      });
  }, [selectedPaths, model, onOpenFile, toAbs, toModelPath]);

  // The context menu reports relative model paths; the App's file-op handlers
  // work in absolute paths, so convert before forwarding.
  const handleFileOp = useCallback(
    (op: FileOp) => {
      switch (op.kind) {
        case "new-file":
        case "new-folder":
          onFileOp({ ...op, dir: toAbs(op.dir) });
          break;
        case "rename":
        case "delete":
          onFileOp({ ...op, path: toAbs(op.path) });
          break;
      }
    },
    [onFileOp, toAbs],
  );

  return (
    <div style={{ height: "100%" }}>
      <PierreFileTree
        model={model}
        style={treeStyle}
        renderContextMenu={(item, context) => (
          <FileTreeContextMenu
            item={item}
            context={context}
            rootPath={rootPath}
            onFileOp={handleFileOp}
          />
        )}
      />
    </div>
  );
}
