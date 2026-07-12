import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";

const STORAGE_KEY = "maincode:recent-repos";
const MAX_RECENTS = 8;

export interface RecentRepo {
  path: string;
  addedAt: number;
}

function readStorage(): RecentRepo[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is RecentRepo =>
        typeof r?.path === "string" && typeof r?.addedAt === "number",
    );
  } catch {
    return [];
  }
}

function writeStorage(items: RecentRepo[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    // ignore
  }
}

interface RecentReposContextValue {
  recent: RecentRepo[];
  addRecent: (path: string) => void;
  removeRecent: (path: string) => void;
}

const RecentReposContext = createContext<RecentReposContextValue | null>(null);

export function RecentReposProvider({ children }: { children: ReactNode }) {
  const [recent, setRecent] = useState<RecentRepo[]>(() => readStorage());

  const addRecent = useCallback((path: string) => {
    setRecent((prev) => {
      const next = [
        { path, addedAt: Date.now() },
        ...prev.filter((r) => r.path !== path),
      ].slice(0, MAX_RECENTS);
      writeStorage(next);
      return next;
    });
  }, []);

  const removeRecent = useCallback((path: string) => {
    setRecent((prev) => {
      const next = prev.filter((r) => r.path !== path);
      writeStorage(next);
      return next;
    });
  }, []);

  return (
    <RecentReposContext.Provider value={{ recent, addRecent, removeRecent }}>
      {children}
    </RecentReposContext.Provider>
  );
}

export function useRecentRepos(): RecentReposContextValue {
  const ctx = useContext(RecentReposContext);
  if (!ctx) {
    throw new Error("useRecentRepos must be used within RecentReposProvider");
  }
  return ctx;
}
