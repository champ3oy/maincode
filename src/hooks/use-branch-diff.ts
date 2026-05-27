import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  getBranchDiff,
  getBranchFileContentsBatch,
  type BranchDiff,
  type FileContentsResponse,
  type FileEntry,
} from "@/lib/tauri";
import type { FileDiffContents } from "@/hooks/use-diffs";
import { perfLog } from "@/lib/perf";

interface UseBranchDiffReturn {
  meta: BranchDiff | null;
  files: FileEntry[];
  diffs: Map<string, FileDiffContents>;
  loading: boolean;
  error: string | null;
  resolved: boolean;
}

const EMPTY_FILES: FileEntry[] = [];

export function useBranchDiff(
  active: boolean,
  workdir: string | null,
): UseBranchDiffReturn {
  const [meta, setMeta] = useState<BranchDiff | null>(null);
  const [diffs, setDiffs] = useState<Map<string, FileDiffContents>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resolved, setResolved] = useState(false);

  // bump to force re-fetch on repo:changed even when workdir/active unchanged
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!active) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    listen("repo:changed", () => setTick((t) => t + 1)).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [active]);

  useEffect(() => {
    if (!active) {
      // Reset on deactivation.
      setMeta(null);
      setDiffs(new Map());
      setLoading(false);
      setError(null);
      setResolved(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setResolved(false);

    void (async () => {
      try {
        const next = await getBranchDiff();
        if (cancelled) return;
        if (!next) {
          setMeta(null);
          setDiffs(new Map());
          setLoading(false);
          setResolved(true);
          return;
        }

        // Detect base/head change to invalidate the diffs cache.
        setMeta((prev) => {
          if (
            prev &&
            prev.base_oid === next.base_oid &&
            prev.head_oid === next.head_oid
          ) {
            return prev;
          }
          // base or head changed — clear diffs to force re-fetch.
          setDiffs(new Map());
          return next;
        });
        setResolved(true);

        if (next.files.length === 0) {
          setDiffs(new Map());
          setLoading(false);
          return;
        }

        const paths = next.files.map((f) => f.path);
        const batch = await getBranchFileContentsBatch({
          baseOid: next.base_oid,
          headOid: next.head_oid,
          requests: paths,
        });
        if (cancelled) return;

        const nextDiffs = new Map<string, FileDiffContents>();
        for (const item of batch) {
          if (!item.response) continue;
          nextDiffs.set(item.path, toFileDiffContents(item.response));
        }
        setDiffs(nextDiffs);
        setLoading(false);
      } catch (e) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : String(e);
        setError(message);
        setMeta(null);
        setDiffs(new Map());
        setLoading(false);
        setResolved(true);
        perfLog("useBranchDiff", "fetch:error", { error: message });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [active, workdir, tick]);

  const files = meta?.files ?? EMPTY_FILES;
  return useMemo(
    () => ({ meta, files, diffs, loading, error, resolved }),
    [meta, files, diffs, loading, error, resolved],
  );
}

function toFileDiffContents(resp: FileContentsResponse): FileDiffContents {
  if (resp.old_binary || resp.new_binary) {
    return {
      kind: "binary",
      oldBinary: resp.old_binary,
      newBinary: resp.new_binary,
    };
  }
  return {
    kind: "text",
    oldFile: { name: resp.name, contents: resp.old_content ?? "" },
    newFile: { name: resp.name, contents: resp.new_content ?? "" },
  };
}
