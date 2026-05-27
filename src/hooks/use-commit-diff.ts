import { useEffect, useMemo, useState } from "react";
import {
  getBranchFileContentsBatch,
  getCommitDiff,
  getRootCommitFileContentsBatch,
  type FileContentsResponse,
  type FileEntry,
} from "@/lib/tauri";
import { perfLog } from "@/lib/perf";
import type { FileDiffContents } from "./use-diffs";

interface UseCommitDiffReturn {
  parentOid: string | null;
  files: FileEntry[];
  diffs: Map<string, FileDiffContents>;
  loading: boolean;
  error: string | null;
}

const EMPTY_FILES: FileEntry[] = [];
const EMPTY_DIFFS: Map<string, FileDiffContents> = new Map();

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

    let cancelled = false;
    setLoading(true);
    setError(null);
    setParentOid(null);
    setFiles(EMPTY_FILES);
    setDiffs(EMPTY_DIFFS);

    void (async () => {
      try {
        const diff = await getCommitDiff(oid);
        if (cancelled) return;

        setParentOid(diff.parent_oid);
        setFiles(diff.files);

        if (diff.files.length === 0) {
          setDiffs(EMPTY_DIFFS);
          setLoading(false);
          return;
        }

        const paths = diff.files.map((f) => f.path);
        const batch = await (diff.parent_oid !== null
          ? getBranchFileContentsBatch({
              baseOid: diff.parent_oid,
              headOid: oid,
              requests: paths,
            })
          : getRootCommitFileContentsBatch({ oid, requests: paths }));
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
        setFiles(EMPTY_FILES);
        setDiffs(new Map());
        setLoading(false);
        perfLog("useCommitDiff", "fetch:error", { error: message, oid });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [oid]);

  return useMemo(
    () => ({ parentOid, files, diffs, loading, error }),
    [parentOid, files, diffs, loading, error],
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
