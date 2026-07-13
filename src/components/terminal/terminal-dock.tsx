import { Fragment, useCallback, useEffect, useState } from "react";
import {
  IconLayoutBottombar,
  IconLayoutSidebarRight,
  IconPlus,
  IconX,
} from "@tabler/icons-react";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { TerminalPanel } from "./terminal-panel";
import {
  getSplitIds,
  setSplitIds,
  allocSplitId,
  syncNextId,
  disposeSession,
} from "./terminal-sessions";

export type TerminalPosition = "bottom" | "right";

interface TerminalDockProps {
  cwd: string;
  /** Where the dock is docked; controls how multiple terminals split. */
  position: TerminalPosition;
  onTogglePosition: () => void;
  /** Called when the last terminal is closed, so the panel can hide. */
  onEmpty: () => void;
}

// Hosts one or more terminals. Split direction adapts to the dock position:
// side by side when docked at the bottom, stacked when docked to the right.
// New terminals are added with "+", each closes independently, and closing the
// last one hides the dock.
export function TerminalDock({
  cwd,
  position,
  onTogglePosition,
  onEmpty,
}: TerminalDockProps) {
  // Initialize from the persistent store so a hide/show cycle restores the same
  // split layout, and keep the store in sync as terminals are added/closed.
  const [terminals, setTerminals] = useState<number[]>(() => getSplitIds());
  useEffect(() => {
    syncNextId();
  }, []);
  useEffect(() => {
    setSplitIds(terminals);
  }, [terminals]);

  const addTerminal = useCallback(() => {
    setTerminals((prev) => [...prev, allocSplitId()]);
  }, []);

  const closeTerminal = useCallback(
    (id: number) => {
      disposeSession(id); // destroy this terminal's pty + xterm
      setTerminals((prev) => {
        const next = prev.filter((t) => t !== id);
        if (next.length === 0) {
          setSplitIds([0]); // reset for the next open
          onEmpty();
        }
        return next;
      });
    },
    [onEmpty],
  );

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border px-2">
        <span className="text-muted-foreground text-xs font-medium">
          Terminal
        </span>
        <div className="text-muted-foreground flex items-center gap-0.5">
          <button
            type="button"
            title={
              position === "bottom"
                ? "Move terminal to the side"
                : "Move terminal to the bottom"
            }
            onClick={onTogglePosition}
            className="flex size-5 items-center justify-center rounded hover:bg-muted hover:text-foreground"
          >
            {position === "bottom" ? (
              <IconLayoutSidebarRight className="size-3.5" />
            ) : (
              <IconLayoutBottombar className="size-3.5" />
            )}
          </button>
          <button
            type="button"
            title="New terminal"
            onClick={addTerminal}
            className="flex size-5 items-center justify-center rounded hover:bg-muted hover:text-foreground"
          >
            <IconPlus className="size-3.5" />
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <ResizablePanelGroup
          orientation={position === "right" ? "vertical" : "horizontal"}
        >
          {terminals.map((id, i) => (
            <Fragment key={id}>
              {i > 0 && <ResizableHandle />}
              <ResizablePanel
                id={`term-${id}`}
                minSize={120}
                className="relative"
              >
                <button
                  type="button"
                  title="Close terminal"
                  onClick={() => closeTerminal(id)}
                  className="text-muted-foreground absolute top-1 right-1 z-10 flex size-5 items-center justify-center rounded hover:bg-muted hover:text-foreground"
                >
                  <IconX className="size-3.5" />
                </button>
                <TerminalPanel id={id} cwd={cwd} />
              </ResizablePanel>
            </Fragment>
          ))}
        </ResizablePanelGroup>
      </div>
    </div>
  );
}
