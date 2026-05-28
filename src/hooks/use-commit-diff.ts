import { useEffect, useMemo, useState } from "react";
import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import { getCommitPatch, type FileEntry } from "@/lib/tauri";
import { perfLog } from "@/lib/perf";
import type { FileDiffContents } from "./use-diffs";

interface UseCommitDiffReturn {
  parentOid: string | null;
  files: FileEntry[];
  diffs: Map<string, FileDiffContents>;
  loading: boolean;
  error: string | null;
}

interface CommitDiffCacheEntry {
  parentOid: string | null;
  files: FileEntry[];
  diffs: Map<string, FileDiffContents>;
}

const EMPTY_FILES: FileEntry[] = [];
const EMPTY_DIFFS: Map<string, FileDiffContents> = new Map();
const MAX_CACHE_ENTRIES = 24;

const cache = new Map<string, CommitDiffCacheEntry>();
const inflight = new Map<string, Promise<CommitDiffCacheEntry>>();

export function useCommitDiff(oid: string | null): UseCommitDiffReturn {
  const [parentOid, setParentOid] = useState<string | null>(null);
  const [files, setFiles] = useState<FileEntry[]>(EMPTY_FILES);
  const [diffs, setDiffs] = useState<Map<string, FileDiffContents>>(EMPTY_DIFFS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (oid === null) {
      setParentOid(null);
      setFiles(EMPTY_FILES);
      setDiffs(EMPTY_DIFFS);
      setLoading(false);
      setError(null);
      return;
    }

    const cached = getCached(oid);
    if (cached) {
      setParentOid(cached.parentOid);
      setFiles(cached.files);
      setDiffs(cached.diffs);
      setLoading(false);
      setError(null);
      perfLog("useCommitDiff", "benchmark:cache-hit", {
        oid: oid.slice(0, 7),
        files: cached.files.length,
      });
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setParentOid(null);
    setFiles(EMPTY_FILES);
    setDiffs(EMPTY_DIFFS);

    loadCommitDiff(oid)
      .then((entry) => {
        if (cancelled) return;
        setParentOid(entry.parentOid);
        setFiles(entry.files);
        setDiffs(entry.diffs);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : String(e);
        setError(message);
        setFiles(EMPTY_FILES);
        setDiffs(new Map());
        setLoading(false);
        perfLog("useCommitDiff", "fetch:error", { error: message, oid });
      });

    return () => {
      cancelled = true;
    };
  }, [oid]);

  return useMemo(
    () => ({ parentOid, files, diffs, loading, error }),
    [parentOid, files, diffs, loading, error],
  );
}

export function prefetchCommitDiff(oid: string): void {
  if (cache.has(oid) || inflight.has(oid)) return;
  void loadCommitDiff(oid).catch((e) => {
    perfLog("useCommitDiff", "prefetch:error", {
      oid: oid.slice(0, 7),
      error: e instanceof Error ? e.message : String(e),
    });
  });
}

function getCached(oid: string): CommitDiffCacheEntry | undefined {
  const entry = cache.get(oid);
  if (!entry) return undefined;
  cache.delete(oid);
  cache.set(oid, entry);
  return entry;
}

function setCached(oid: string, entry: CommitDiffCacheEntry): void {
  cache.delete(oid);
  cache.set(oid, entry);
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

function loadCommitDiff(oid: string): Promise<CommitDiffCacheEntry> {
  const cached = getCached(oid);
  if (cached) return Promise.resolve(cached);

  const pending = inflight.get(oid);
  if (pending) return pending;

  const promise = (async () => {
    const totalStart = performance.now();
    const backendStart = performance.now();
    const response = await getCommitPatch(oid);
    const backendMs = +(performance.now() - backendStart).toFixed(2);

    const parseStart = performance.now();
    const parsedByPath = parsePatchByPath(response.patch, oid);
    let parsedFiles = 0;
    let totalAdditions = 0;
    let totalDeletions = 0;
    const files = response.files.map((file) => {
      const parsed = parsedByPath.get(file.path);
      if (!parsed) return file;
      parsedFiles += 1;
      const counts = countParsedDiff(parsed);
      totalAdditions += counts.additions;
      totalDeletions += counts.deletions;
      if (
        file.additions === counts.additions &&
        file.deletions === counts.deletions
      ) {
        return file;
      }
      return {
        ...file,
        additions: counts.additions,
        deletions: counts.deletions,
      };
    });

    const diffs = new Map<string, FileDiffContents>();
    for (const file of files) {
      const parsed = parsedByPath.get(file.path);
      diffs.set(
        file.path,
        parsed
          ? { kind: "parsed", fileDiff: parsed }
          : binaryContentsFor(file),
      );
    }
    const parseMs = +(performance.now() - parseStart).toFixed(2);

    const entry = {
      parentOid: response.parent_oid,
      files,
      diffs,
    };
    setCached(oid, entry);
    perfLog("useCommitDiff", "benchmark:load", {
      oid: oid.slice(0, 7),
      files: files.length,
      parsedFiles,
      patchChars: response.patch.length,
      additions: totalAdditions,
      deletions: totalDeletions,
      backendMs,
      parseMs,
      totalMs: +(performance.now() - totalStart).toFixed(2),
    });
    return entry;
  })();

  inflight.set(oid, promise);
  promise.finally(() => {
    inflight.delete(oid);
  });
  return promise;
}

function parsePatchByPath(
  patch: string,
  oid: string,
): Map<string, FileDiffMetadata> {
  const parsed = parsePatchFiles(patch, `commit-${oid}`);
  const byPath = new Map<string, FileDiffMetadata>();
  for (const parsedPatch of parsed) {
    for (const file of parsedPatch.files) {
      byPath.set(file.name, file);
    }
  }
  return byPath;
}

function countParsedDiff(file: FileDiffMetadata): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const hunk of file.hunks) {
    additions += hunk.additionLines;
    deletions += hunk.deletionLines;
  }
  return { additions, deletions };
}

function binaryContentsFor(file: FileEntry): FileDiffContents {
  return {
    kind: "binary",
    oldBinary: file.kind !== "added",
    newBinary: file.kind !== "deleted",
  };
}
