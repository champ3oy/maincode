import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  IconChevronDown,
  IconChevronRight,
  IconFile,
  IconFolder,
  IconFolderOpen,
} from "@tabler/icons-react";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { readDir, type DirEntryInfo } from "@/lib/fs";

interface FileTreeProps {
  rootPath: string;
  selectedPath: string | null;
  onOpenFile: (path: string) => void;
  refreshNonce?: number;
}

export function FileTree({
  rootPath,
  selectedPath,
  onOpenFile,
  refreshNonce = 0,
}: FileTreeProps) {
  const [children, setChildren] = useState<Map<string, DirEntryInfo[]>>(
    new Map(),
  );
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const loadDir = useCallback(async (dirPath: string) => {
    try {
      const entries = await readDir(dirPath);
      setChildren((prev) => {
        const next = new Map(prev);
        next.set(dirPath, entries);
        return next;
      });
    } catch (e) {
      toast.error(`Failed to read ${dirPath}: ${e}`);
    }
  }, []);

  // Reset and load the root whenever the workspace changes.
  useEffect(() => {
    setChildren(new Map());
    setExpanded(new Set());
    void loadDir(rootPath);
  }, [rootPath, loadDir]);

  // Reload root + expanded dirs on explicit refresh or watcher events.
  const refreshLoaded = useCallback(() => {
    void loadDir(rootPath);
    setExpanded((current) => {
      current.forEach((dir) => void loadDir(dir));
      return current;
    });
  }, [rootPath, loadDir]);

  useEffect(() => {
    if (refreshNonce > 0) refreshLoaded();
  }, [refreshNonce, refreshLoaded]);

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

  const toggleDir = useCallback(
    (dirPath: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(dirPath)) {
          next.delete(dirPath);
        } else {
          next.add(dirPath);
          if (!children.has(dirPath)) void loadDir(dirPath);
        }
        return next;
      });
    },
    [children, loadDir],
  );

  const renderEntries = (dirPath: string, depth: number): ReactNode => {
    const entries = children.get(dirPath);
    if (!entries) {
      return depth === 0 ? (
        <p className="text-muted-foreground px-2 py-1 text-xs">Loading…</p>
      ) : null;
    }
    return entries.map((node) => {
      const isOpen = node.is_dir && expanded.has(node.path);
      return (
        <div key={node.path}>
          <button
            type="button"
            title={node.path}
            className={cn(
              "flex h-6 w-full cursor-pointer items-center gap-1.5 rounded-sm px-1 text-left text-xs",
              selectedPath === node.path
                ? "bg-accent text-accent-foreground"
                : "hover:bg-muted/40",
            )}
            style={{ paddingLeft: depth * 12 + 4 }}
            onClick={() =>
              node.is_dir ? toggleDir(node.path) : onOpenFile(node.path)
            }
          >
            {node.is_dir ? (
              <>
                {isOpen ? (
                  <IconChevronDown className="size-3 shrink-0" />
                ) : (
                  <IconChevronRight className="size-3 shrink-0" />
                )}
                {isOpen ? (
                  <IconFolderOpen className="size-3.5 shrink-0 text-amber-600" />
                ) : (
                  <IconFolder className="size-3.5 shrink-0 text-amber-600" />
                )}
              </>
            ) : (
              <IconFile className="text-muted-foreground ml-4 size-3.5 shrink-0" />
            )}
            <span className="truncate">{node.name}</span>
          </button>
          {isOpen && renderEntries(node.path, depth + 1)}
        </div>
      );
    });
  };

  return <div className="py-1">{renderEntries(rootPath, 0)}</div>;
}
