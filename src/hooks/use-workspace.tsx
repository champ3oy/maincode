import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";

const LAST_FOLDER_KEY = "maincode:last-folder";

export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i === -1 ? trimmed : trimmed.slice(i + 1);
}

export function readLastFolder(): string | null {
  try {
    return window.localStorage.getItem(LAST_FOLDER_KEY);
  } catch {
    return null;
  }
}

interface WorkspaceContextValue {
  rootPath: string | null;
  rootName: string | null;
  openFolder: (path: string) => void;
  closeFolder: () => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [rootPath, setRootPath] = useState<string | null>(null);

  const openFolder = useCallback((path: string) => {
    setRootPath(path);
    try {
      window.localStorage.setItem(LAST_FOLDER_KEY, path);
    } catch {
      // ignore
    }
  }, []);

  const closeFolder = useCallback(() => {
    setRootPath(null);
    try {
      window.localStorage.removeItem(LAST_FOLDER_KEY);
    } catch {
      // ignore
    }
  }, []);

  return (
    <WorkspaceContext.Provider
      value={{
        rootPath,
        rootName: rootPath ? basename(rootPath) : null,
        openFolder,
        closeFolder,
      }}
    >
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace must be used within WorkspaceProvider");
  return ctx;
}
