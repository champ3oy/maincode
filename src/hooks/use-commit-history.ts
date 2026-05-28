import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  COMMIT_HISTORY_CHUNK_EVENT,
  COMMIT_HISTORY_DONE_EVENT,
  COMMIT_HISTORY_ERROR_EVENT,
  getHeadState,
  listCommitsStream,
  type CommitGraphRow,
  type CommitHistoryChunkPayload,
  type CommitHistoryDonePayload,
  type CommitDetails,
  type CommitHistoryErrorPayload,
} from "@/lib/tauri";
import { perfLog } from "@/lib/perf";
import { useCommitDetailsCache } from "./use-commit-details-cache";

export interface CommitHistoryState {
  oids: string[];
  decorations: Map<string, CommitGraphRow>;
  loaded: number;
  total: number | null;
  done: boolean;
  error: string | null;
  branch: string | null;
  headOid: string | null;
}

interface CacheEntry {
  oids: string[];
  decorations: Map<string, CommitGraphRow>;
  total: number | null;
}

const EMPTY_OIDS: string[] = [];
const EMPTY_DECORATIONS: Map<string, CommitGraphRow> = new Map();

// Module-level cache. The plan calls for "latest entry only" semantics; we use
// a Map keyed by (workdir, branch, head_oid) so tab toggles or no-op
// `repo:changed` events can re-hydrate without re-walking.
const cache = new Map<string, CacheEntry>();

function cacheKey(
  workdir: string,
  branch: string | null,
  headOid: string,
): string {
  return `${workdir}::${branch ?? "<detached>"}::${headOid}`;
}

function detailsFromGraphRow(row: CommitGraphRow): CommitDetails {
  return {
    oid: row.oid,
    subject: row.subject,
    body: "",
    author_name: row.author_name,
    author_email: row.author_email,
    author_timestamp: row.author_timestamp,
    committer_name: row.committer_name,
    committer_email: row.committer_email,
    committer_timestamp: row.committer_timestamp,
  };
}

export function useCommitHistory(
  active: boolean,
  workdir: string | null,
): CommitHistoryState {
  const [oids, setOids] = useState<string[]>(EMPTY_OIDS);
  const [decorations, setDecorations] =
    useState<Map<string, CommitGraphRow>>(EMPTY_DECORATIONS);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [branch, setBranch] = useState<string | null>(null);
  const [headOid, setHeadOid] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const { primeDetails } = useCommitDetailsCache();

  // The authoritative request id for the in-flight walk. Listener callbacks
  // compare against this to drop chunks from stale requests.
  const activeRequestIdRef = useRef<string | null>(null);
  // Mirror of (branch, headOid) for the *current* walk; consulted from
  // repo:changed and done handlers without re-rendering.
  const headRef = useRef<{ branch: string | null; headOid: string | null }>({
    branch: null,
    headOid: null,
  });
  // Mirror of streaming state so the `done` handler can snapshot into the
  // cache without nested setState gymnastics.
  const oidsRef = useRef<string[]>(EMPTY_OIDS);
  const decorationsRef =
    useRef<Map<string, CommitGraphRow>>(EMPTY_DECORATIONS);
  const totalRef = useRef<number | null>(null);

  useEffect(() => {
    if (!active || !workdir) return;

    const currentWorkdir = workdir;
    let cancelled = false;
    const unlisteners: Array<() => void> = [];

    const resetWalkState = () => {
      oidsRef.current = [];
      decorationsRef.current = new Map();
      totalRef.current = null;
      setOids(oidsRef.current);
      setDecorations(decorationsRef.current);
      setDone(false);
      setTotal(null);
      setError(null);
    };

    const hydrateFromCache = (entry: CacheEntry) => {
      oidsRef.current = entry.oids;
      decorationsRef.current = entry.decorations;
      totalRef.current = entry.total;
      activeRequestIdRef.current = null;
      setOids(entry.oids);
      setDecorations(entry.decorations);
      setTotal(entry.total);
      setDone(true);
      setError(null);
    };

    const startWalk = async (head: {
      branch: string | null;
      head_oid: string;
    }) => {
      headRef.current = { branch: head.branch, headOid: head.head_oid };
      setBranch(head.branch);
      setHeadOid(head.head_oid);

      const key = cacheKey(currentWorkdir, head.branch, head.head_oid);
      const cached = cache.get(key);
      if (cached) {
        hydrateFromCache(cached);
        perfLog("useCommitHistory", "walk:cache-hit", {
          branch: head.branch,
          head: head.head_oid.slice(0, 7),
          count: cached.oids.length,
          total: cached.total,
        });
        return;
      }

      const requestId = crypto.randomUUID();
      activeRequestIdRef.current = requestId;
      resetWalkState();
      perfLog("useCommitHistory", "walk:start", {
        branch: head.branch,
        head: head.head_oid.slice(0, 7),
        requestId,
      });
      try {
        const ack = await listCommitsStream({ branch: head.branch, requestId });
        if (cancelled || activeRequestIdRef.current !== requestId) return;
        if (ack.total_estimate !== null) {
          totalRef.current = ack.total_estimate;
          setTotal(ack.total_estimate);
        }
      } catch (err) {
        if (cancelled || activeRequestIdRef.current !== requestId) return;
        const message = err instanceof Error ? err.message : String(err);
        activeRequestIdRef.current = null;
        setError(message);
        setDone(true);
        perfLog("useCommitHistory", "walk:error", {
          requestId,
          error: message,
        });
      }
    };

    const probe = async () => {
      let head: { branch: string | null; head_oid: string };
      try {
        head = await getHeadState();
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        setDone(true);
        perfLog("useCommitHistory", "walk:error", { error: message });
        return;
      }
      if (cancelled) return;
      const cur = headRef.current;
      // Head unchanged → no-op. Covers both the "already loaded" and
      // "currently walking" cases; the request_id check in callbacks keeps
      // any concurrent stream coherent.
      if (cur.branch === head.branch && cur.headOid === head.head_oid) return;
      await startWalk(head);
    };

    const setupListeners = async () => {
      const listeners = await Promise.all([
        listen<CommitHistoryChunkPayload>(COMMIT_HISTORY_CHUNK_EVENT, (event) => {
          const payload = event.payload;
          if (payload.request_id !== activeRequestIdRef.current) return;
          if (payload.total_estimate !== null) {
            totalRef.current = payload.total_estimate;
            setTotal(payload.total_estimate);
          }
          if (payload.oids.length === 0) return;
          const nextOids = oidsRef.current.slice();
          const nextDecs = new Map(decorationsRef.current);
          const details: CommitDetails[] = [];
          for (const row of payload.oids) {
            nextOids.push(row.oid);
            nextDecs.set(row.oid, row);
            details.push(detailsFromGraphRow(row));
          }
          oidsRef.current = nextOids;
          decorationsRef.current = nextDecs;
          primeDetails(details);
          setOids(nextOids);
          setDecorations(nextDecs);
          perfLog("useCommitHistory", "walk:chunk", {
            count: payload.oids.length,
            loaded: nextOids.length,
            total: totalRef.current,
          });
        }),
        listen<CommitHistoryDonePayload>(COMMIT_HISTORY_DONE_EVENT, (event) => {
          const payload = event.payload;
          if (payload.request_id !== activeRequestIdRef.current) return;
          if (payload.total_estimate !== null) {
            totalRef.current = payload.total_estimate;
            setTotal(payload.total_estimate);
          }
          const head = headRef.current;
          activeRequestIdRef.current = null;
          setDone(true);
          if (head.headOid) {
            cache.set(cacheKey(currentWorkdir, head.branch, head.headOid), {
              oids: oidsRef.current,
              decorations: decorationsRef.current,
              total: totalRef.current ?? oidsRef.current.length,
            });
          }
          perfLog("useCommitHistory", "walk:done", {
            branch: head.branch,
            head: head.headOid?.slice(0, 7),
            count: oidsRef.current.length,
            total: totalRef.current,
          });
        }),
        listen<CommitHistoryErrorPayload>(COMMIT_HISTORY_ERROR_EVENT, (event) => {
          const payload = event.payload;
          if (payload.request_id !== activeRequestIdRef.current) return;
          activeRequestIdRef.current = null;
          setError(payload.message);
          setDone(true);
          perfLog("useCommitHistory", "walk:error", {
            requestId: payload.request_id,
            error: payload.message,
          });
        }),
        listen("repo:changed", () => {
          if (cancelled) return;
          void probe();
        }),
      ]);

      if (cancelled) {
        for (const fn of listeners) fn();
        return;
      }
      unlisteners.push(...listeners);
      void probe();
    };

    void setupListeners();

    return () => {
      cancelled = true;
      for (const fn of unlisteners) fn();
      activeRequestIdRef.current = null;
      headRef.current = { branch: null, headOid: null };
      oidsRef.current = EMPTY_OIDS;
      totalRef.current = null;
      decorationsRef.current = EMPTY_DECORATIONS;
      setOids(EMPTY_OIDS);
      setDecorations(EMPTY_DECORATIONS);
      setDone(false);
      setTotal(null);
      setError(null);
      setBranch(null);
      setHeadOid(null);
    };
  }, [active, workdir, primeDetails]);

  const loaded = oids.length;

  return useMemo(
    () => ({ oids, decorations, loaded, total, done, error, branch, headOid }),
    [oids, decorations, loaded, total, done, error, branch, headOid],
  );
}
