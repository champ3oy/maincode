import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { getCommitDetailsBatch, type CommitDetails } from "@/lib/tauri";
import { perfLog } from "@/lib/perf";

const FLUSH_DELAY_MS = 50;

type CacheEntry = CommitDetails | "pending";
type Cache = Map<string, CacheEntry>;

interface CommitDetailsCacheContextValue {
  cache: Cache;
  requestVisible: (oids: string[]) => void;
  getDetails: (oid: string) => CacheEntry | undefined;
}

const CommitDetailsCacheContext =
  createContext<CommitDetailsCacheContextValue | null>(null);

export function CommitDetailsCacheProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [cache, setCache] = useState<Cache>(() => new Map());
  const cacheRef = useRef<Cache>(cache);
  cacheRef.current = cache;

  const queueRef = useRef<Set<string>>(new Set());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    timerRef.current = null;
    if (queueRef.current.size === 0) return;
    const batch = Array.from(queueRef.current);
    queueRef.current.clear();
    perfLog("history", "commit-details:batch", { count: batch.length });
    getCommitDetailsBatch(batch)
      .then((results) => {
        const returned = new Set<string>();
        for (const r of results) returned.add(r.oid);
        setCache((prev) => {
          const next = new Map(prev);
          for (const r of results) next.set(r.oid, r);
          // Evict oids that the backend did not return so a later
          // requestVisible can retry them instead of staying 'pending'.
          for (const oid of batch) {
            if (!returned.has(oid) && next.get(oid) === "pending") {
              next.delete(oid);
            }
          }
          return next;
        });
      })
      .catch((err) => {
        perfLog("history", "commit-details:batch-error", {
          error: String(err),
          count: batch.length,
        });
        setCache((prev) => {
          const next = new Map(prev);
          for (const oid of batch) {
            if (next.get(oid) === "pending") next.delete(oid);
          }
          return next;
        });
      });
  }, []);

  const scheduleFlush = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(flush, FLUSH_DELAY_MS);
  }, [flush]);

  const requestVisible = useCallback(
    (oids: string[]) => {
      if (oids.length === 0) return;
      const current = cacheRef.current;
      const newOids: string[] = [];
      for (const oid of oids) {
        if (current.has(oid)) continue;
        if (queueRef.current.has(oid)) continue;
        newOids.push(oid);
      }
      if (newOids.length === 0) return;
      for (const oid of newOids) queueRef.current.add(oid);
      setCache((prev) => {
        const next = new Map(prev);
        for (const oid of newOids) {
          if (!next.has(oid)) next.set(oid, "pending");
        }
        return next;
      });
      scheduleFlush();
    },
    [scheduleFlush],
  );

  const getDetails = useCallback(
    (oid: string) => cache.get(oid),
    [cache],
  );

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  const value = useMemo<CommitDetailsCacheContextValue>(
    () => ({ cache, requestVisible, getDetails }),
    [cache, requestVisible, getDetails],
  );

  return (
    <CommitDetailsCacheContext.Provider value={value}>
      {children}
    </CommitDetailsCacheContext.Provider>
  );
}

export function useCommitDetailsCache(): CommitDetailsCacheContextValue {
  const ctx = useContext(CommitDetailsCacheContext);
  if (!ctx) {
    throw new Error(
      "useCommitDetailsCache must be used within CommitDetailsCacheProvider",
    );
  }
  return ctx;
}
