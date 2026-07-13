import { useEffect, useRef } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { useEditor } from "@/hooks/use-editor";
import { isImagePath } from "@/lib/image";
import { CodeEditor } from "./code-editor";
import { ImageViewer } from "./image-viewer";
import { TabBar } from "./tab-bar";

interface EditorAreaProps {
  onCursor?: (line: number, col: number) => void;
}

export function EditorArea({ onCursor }: EditorAreaProps) {
  const {
    tabs,
    activeTab,
    activateTab,
    closeTab,
    editFile,
    saveFile,
    isDirty,
  } = useEditor();

  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;

  const handleClose = async (path: string) => {
    const tab = tabsRef.current.find((t) => t.path === path);
    if (tab && isDirty(tab)) {
      const ok = await ask(`Close ${tab.name} without saving?`, {
        title: "Unsaved changes",
        kind: "warning",
      });
      if (!ok) return;
    }
    closeTab(path);
  };
  const handleCloseRef = useRef(handleClose);
  handleCloseRef.current = handleClose;

  // Cmd+W closes the active tab (CodeMirror doesn't capture it).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "w") {
        e.preventDefault();
        const active = activeTabRef.current;
        if (active) void handleCloseRef.current(active.path);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex h-full flex-col">
      <TabBar
        tabs={tabs}
        activePath={activeTab?.path ?? null}
        onActivate={activateTab}
        onClose={(path) => void handleClose(path)}
      />
      {activeTab ? (
        <div className="min-h-0 flex-1">
          {isImagePath(activeTab.path) ? (
            <ImageViewer path={activeTab.path} />
          ) : (
            <CodeEditor
              path={activeTab.path}
              content={activeTab.content}
              onChange={editFile}
              onSave={(path) => void saveFile(path)}
              onCursor={onCursor}
            />
          )}
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-muted-foreground text-sm">
            Open a file from the sidebar
          </p>
        </div>
      )}
    </div>
  );
}
