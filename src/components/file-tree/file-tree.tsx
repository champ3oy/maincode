import { type CSSProperties, useEffect, useRef, useState } from "react";
import { FileTree as PierreFileTree, useFileTree, useFileTreeSelection } from "@pierre/trees/react";
import { listen } from "@tauri-apps/api/event";
import { readDir, type DirEntryInfo } from "@/lib/fs";

interface FileTreeProps {
  rootPath: string;
  onOpenFile: (path: string) => void;
  refreshNonce?: number;
}

const toModelPath = (e: DirEntryInfo): string =>
  e.is_dir ? e.path + "/" : e.path;

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
  refreshNonce = 0,
}: FileTreeProps) {
  const [paths, setPaths] = useState<string[]>([]);
  // Set of fs paths (without trailing slash) that have been loaded
  const loadedDirs = useRef<Set<string>>(new Set());
  // Set of model-paths (with trailing slash) that are currently expanded
  const expandedModelPaths = useRef<Set<string>>(new Set());

  const { model } = useFileTree({
    id: "files-browser",
    paths,
    initialExpansion: "closed",
    flattenEmptyDirectories: false,
    density: "compact",
    icons: { set: "standard", colored: true },
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
    loadedDirs.current = new Set();
    expandedModelPaths.current = new Set();
    setPaths([]);

    readDir(rootPath)
      .then((entries) => {
        if (cancelled) return;
        loadedDirs.current.add(rootPath);
        setPaths(entries.map(toModelPath));
      })
      .catch(() => {
        // ignore — root dir read failure is handled gracefully (empty tree)
      });

    return () => {
      cancelled = true;
    };
  }, [rootPath]);

  // Refresh: re-read all loaded dirs, rebuild paths set
  const refreshLoaded = () => {
    const currentLoaded = [...loadedDirs.current];
    Promise.all(
      currentLoaded.map((dir) =>
        readDir(dir).then((entries) => ({ dir, entries })).catch(() => null),
      ),
    ).then((results) => {
      // Build a new paths set: union of all loaded dir entries
      // Each dir's entries are model-path form
      const modelPathSet = new Set<string>();
      for (const result of results) {
        if (!result) continue;
        for (const e of result.entries) {
          modelPathSet.add(toModelPath(e));
        }
      }
      const newPaths = [...modelPathSet];
      // Keep expandedModelPaths in sync (only keep dirs that still exist)
      const stillExpanded = new Set<string>();
      for (const mp of expandedModelPaths.current) {
        if (modelPathSet.has(mp)) stillExpanded.add(mp);
      }
      expandedModelPaths.current = stillExpanded;
      setPaths(newPaths);
    });
  };

  // refreshNonce prop: bump to force reload
  const prevNonce = useRef(0);
  useEffect(() => {
    if (refreshNonce > 0 && refreshNonce !== prevNonce.current) {
      prevNonce.current = refreshNonce;
      refreshLoaded();
    }
  });

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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Selection → lazy-load directories / open files
  const selectedPaths = useFileTreeSelection(model);
  const lastHandledRef = useRef<string | null>(null);

  useEffect(() => {
    if (selectedPaths.length === 0) return;
    const path = selectedPaths[selectedPaths.length - 1];
    if (path === lastHandledRef.current) return;
    lastHandledRef.current = path;

    const item = model.getItem(path);
    if (!item) return;

    if (!item.isDirectory()) {
      // It's a file — open it
      onOpenFile(path);
      return;
    }

    // It's a directory. Strip trailing slash for the fs path.
    const fsPath = path.replace(/\/$/, "");

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
  }, [selectedPaths, model, onOpenFile]);

  return (
    <div style={{ height: "100%" }}>
      <PierreFileTree model={model} style={treeStyle} />
    </div>
  );
}
