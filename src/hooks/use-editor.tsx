import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import { readFile, writeFile } from "@/lib/fs";
import { basename } from "@/hooks/use-workspace";
import {
  initialTabsState,
  isDirty,
  tabsReducer,
  type EditorTab,
  type TabsState,
} from "./editor-tabs-reducer";

interface EditorContextValue {
  tabs: EditorTab[];
  activeTab: EditorTab | null;
  dirtyCount: number;
  openFile: (path: string) => Promise<void>;
  editFile: (path: string, content: string) => void;
  saveFile: (path: string) => Promise<void>;
  closeTab: (path: string) => void;
  activateTab: (path: string) => void;
  handlePathRenamed: (from: string, to: string) => void;
  isDirty: (tab: EditorTab) => boolean;
}

const EditorContext = createContext<EditorContextValue | null>(null);

export function EditorProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(tabsReducer, initialTabsState);
  const stateRef = useRef<TabsState>(state);
  stateRef.current = state;

  const openFile = useCallback(async (path: string) => {
    // Already open → activate it without touching content.
    if (stateRef.current.tabs.some((t) => t.path === path)) {
      dispatch({ type: "activate", path });
      return;
    }
    const result = await readFile(path).catch((e) => {
      toast.error(`Failed to open: ${e}`);
      return null;
    });
    if (!result) return;
    if (result.content === null) {
      toast.error(
        result.reason === "too_large"
          ? "File is larger than 2 MB — not opening it here"
          : "Cannot open a binary file",
      );
      return;
    }
    dispatch({
      type: "open",
      path,
      name: basename(path),
      content: result.content,
    });
  }, []);

  const editFile = useCallback((path: string, content: string) => {
    dispatch({ type: "edit", path, content });
  }, []);

  const saveFile = useCallback(async (path: string) => {
    const tab = stateRef.current.tabs.find((t) => t.path === path);
    if (!tab) return;
    try {
      await writeFile(path, tab.content);
      dispatch({ type: "markSaved", path });
    } catch (e) {
      toast.error(`Save failed: ${e}`);
    }
  }, []);

  const closeTab = useCallback((path: string) => {
    dispatch({ type: "close", path });
  }, []);

  const activateTab = useCallback((path: string) => {
    dispatch({ type: "activate", path });
  }, []);

  const handlePathRenamed = useCallback((from: string, to: string) => {
    dispatch({ type: "renamePath", from, to, name: basename(to) });
  }, []);

  const value = useMemo<EditorContextValue>(() => {
    const activeTab =
      state.tabs.find((t) => t.path === state.activePath) ?? null;
    return {
      tabs: state.tabs,
      activeTab,
      dirtyCount: state.tabs.filter(isDirty).length,
      openFile,
      editFile,
      saveFile,
      closeTab,
      activateTab,
      handlePathRenamed,
      isDirty,
    };
  }, [
    state,
    openFile,
    editFile,
    saveFile,
    closeTab,
    activateTab,
    handlePathRenamed,
  ]);

  return (
    <EditorContext.Provider value={value}>{children}</EditorContext.Provider>
  );
}

export function useEditor(): EditorContextValue {
  const ctx = useContext(EditorContext);
  if (!ctx) throw new Error("useEditor must be used within EditorProvider");
  return ctx;
}
