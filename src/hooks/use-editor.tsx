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
import { useSettings } from "@/hooks/use-settings";
import { isImagePath } from "@/lib/image";
import { isSettingsPath, SETTINGS_PATH } from "@/lib/settings";
import { basename } from "@/hooks/use-workspace";
import { formatContent, resolvePrettierConfig } from "@/lib/format";
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
  formatFile: (path: string) => Promise<void>;
  closeTab: (path: string) => void;
  closeAllTabs: () => void;
  activateTab: (path: string) => void;
  handlePathRenamed: (from: string, to: string) => void;
  isDirty: (tab: EditorTab) => boolean;
  /** Set the project root so formatFile can resolve .prettierrc config. */
  setFormatRoot: (root: string | null) => void;
  /**
   * Registered by the mounted CodeEditor: formats the ACTIVE document through
   * the live view (visible change, cursor preserved, undoable). Returns the
   * formatted text, or null when it can't handle the path (not the active
   * document, or no parser).
   */
  registerViewFormatter: (
    fn: (path: string, config: object) => Promise<string | null>,
  ) => void;
}

const EditorContext = createContext<EditorContextValue | null>(null);

export function EditorProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(tabsReducer, initialTabsState);
  const stateRef = useRef<TabsState>(state);
  stateRef.current = state;

  // rootPath for .prettierrc config resolution; set from App via setFormatRoot.
  const formatRootRef = useRef<string | null>(null);

  // View-level formatter registered by the mounted CodeEditor. Formatting must
  // go through the live view — a state-only edit never reaches the uncontrolled
  // EditorView, so the buffer wouldn't visibly change.
  const viewFormatterRef = useRef<
    ((path: string, config: object) => Promise<string | null>) | null
  >(null);
  const registerViewFormatter = useCallback(
    (fn: (path: string, config: object) => Promise<string | null>) => {
      viewFormatterRef.current = fn;
    },
    [],
  );

  const { settings } = useSettings();
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const openFile = useCallback(async (path: string) => {
    // Already open → activate it without touching content.
    if (stateRef.current.tabs.some((t) => t.path === path)) {
      dispatch({ type: "activate", path });
      return;
    }
    // Settings pseudo-tab: no file to read; render via SettingsView.
    if (isSettingsPath(path)) {
      dispatch({ type: "open", path, name: "Settings", content: "" });
      return;
    }
    // Image files are displayed by ImageViewer; they hold empty text content.
    if (isImagePath(path)) {
      dispatch({ type: "open", path, name: basename(path), content: "" });
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

  const formatFile = useCallback(async (path: string) => {
    // Guards: settings and image tabs have no meaningful text content.
    if (isSettingsPath(path)) return;
    if (isImagePath(path)) return;
    const tab = stateRef.current.tabs.find((t) => t.path === path);
    if (!tab) return;
    const config = await resolvePrettierConfig(formatRootRef.current).catch(() => ({}));
    try {
      // Prefer the live view (visible change, cursor preserved, undoable).
      // Its updateListener syncs the tab state via onChange.
      const viaView = await viewFormatterRef.current?.(path, config);
      if (typeof viaView === "string") return;

      // Fallback (path not in the active view): format the tab content.
      const formatted = await formatContent(tab.content, path, config);
      if (formatted === null) {
        toast.info("No formatter for this file type");
        return;
      }
      if (formatted !== tab.content) {
        dispatch({ type: "edit", path, content: formatted });
      }
    } catch (err) {
      toast.error(`Format failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  const saveFile = useCallback(async (path: string) => {
    // CRITICAL: settings and image tabs hold empty content — writing would destroy files.
    if (isSettingsPath(path)) return;
    if (isImagePath(path)) return;
    const tab = stateRef.current.tabs.find((t) => t.path === path);
    if (!tab) return;
    try {
      let content = tab.content;
      // Format-on-save: format the ACTIVE document through the live view
      // (visible change, cursor preserved, single undo step), then write the
      // formatted text once. Non-active tabs (Save All) are written as-is —
      // formatting them behind the scenes would desync the cached editor
      // state from the tab content.
      if (settingsRef.current.editor.formatOnSave) {
        const config = await resolvePrettierConfig(formatRootRef.current).catch(() => ({}));
        try {
          const viaView = await viewFormatterRef.current?.(path, config);
          if (typeof viaView === "string") content = viaView;
        } catch (err) {
          // Format error on save: warn but still save the original content.
          toast.error(`Format failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      await writeFile(path, content);
      dispatch({ type: "markSaved", path });
    } catch (e) {
      toast.error(`Save failed: ${e}`);
    }
  }, []);

  const setFormatRoot = useCallback((root: string | null) => {
    formatRootRef.current = root;
  }, []);

  const closeTab = useCallback((path: string) => {
    dispatch({ type: "close", path });
  }, []);

  const closeAllTabs = useCallback(() => {
    dispatch({ type: "reset" });
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
      formatFile,
      closeTab,
      closeAllTabs,
      activateTab,
      handlePathRenamed,
      isDirty,
      setFormatRoot,
      registerViewFormatter,
    };
  }, [
    state,
    openFile,
    editFile,
    saveFile,
    formatFile,
    closeTab,
    closeAllTabs,
    activateTab,
    handlePathRenamed,
    setFormatRoot,
    registerViewFormatter,
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
