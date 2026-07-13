import { useEffect, useRef } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { useEditor } from "@/hooks/use-editor";
import { isImagePath } from "@/lib/image";
import { isSettingsPath, settingsPath } from "@/lib/settings";
import type { DefinitionResult } from "@/lib/ts-worker/protocol";
import { CodeEditor } from "./code-editor";
import { ImageViewer } from "./image-viewer";
import { SettingsView } from "./settings-view";
import { TabBar } from "./tab-bar";

interface EditorAreaProps {
  onCursor?: (line: number, col: number) => void;
  formatRoot?: string | null;
  /** Cmd/Ctrl+Click go-to-definition target from the TS worker. */
  onGoToDefinition?: (target: DefinitionResult) => void;
  /** Reveal target for the active editor (drives cross-file go-to-def jumps). */
  revealTarget?: { path: string; line: number; column: number } | null;
  onRevealConsumed?: () => void;
}

export function EditorArea({
  onCursor,
  formatRoot,
  onGoToDefinition,
  revealTarget,
  onRevealConsumed,
}: EditorAreaProps) {
  const {
    tabs,
    activeTab,
    activateTab,
    closeTab,
    editFile,
    saveFile,
    openFile,
    isDirty,
    registerViewFormatter,
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
          {isSettingsPath(activeTab.path) ? (
            <SettingsView
              onEditJson={() => {
                void settingsPath().then((p) => void openFile(p));
              }}
            />
          ) : isImagePath(activeTab.path) ? (
            <ImageViewer path={activeTab.path} />
          ) : (
            <CodeEditor
              path={activeTab.path}
              content={activeTab.content}
              onChange={editFile}
              onSave={(path) => void saveFile(path)}
              onCursor={onCursor}
              formatRoot={formatRoot}
              onRegisterFormatter={registerViewFormatter}
              onGoToDefinition={onGoToDefinition}
              revealTarget={revealTarget}
              onRevealConsumed={onRevealConsumed}
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
