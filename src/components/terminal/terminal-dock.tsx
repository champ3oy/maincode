import { Fragment, useCallback, useRef, useState } from "react";
import { IconPlus, IconX } from "@tabler/icons-react";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { TerminalPanel } from "./terminal-panel";

interface TerminalDockProps {
  cwd: string;
  /** Called when the last terminal is closed, so the panel can hide. */
  onEmpty: () => void;
}

// Hosts one or more terminals side by side as vertical splits. New terminals
// are added with "+", each can be closed independently, and closing the last
// one hides the dock.
export function TerminalDock({ cwd, onEmpty }: TerminalDockProps) {
  const nextId = useRef(1);
  const [terminals, setTerminals] = useState<number[]>([0]);

  const addTerminal = useCallback(() => {
    setTerminals((prev) => [...prev, nextId.current++]);
  }, []);

  const closeTerminal = useCallback(
    (id: number) => {
      setTerminals((prev) => {
        const next = prev.filter((t) => t !== id);
        if (next.length === 0) onEmpty();
        return next;
      });
    },
    [onEmpty],
  );

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex h-7 shrink-0 items-center justify-between border-b border-border px-2">
        <span className="text-muted-foreground text-xs font-medium">
          Terminal
        </span>
        <button
          type="button"
          title="New terminal"
          onClick={addTerminal}
          className="text-muted-foreground flex size-5 items-center justify-center rounded hover:bg-muted hover:text-foreground"
        >
          <IconPlus className="size-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <ResizablePanelGroup orientation="horizontal">
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
                <TerminalPanel cwd={cwd} />
              </ResizablePanel>
            </Fragment>
          ))}
        </ResizablePanelGroup>
      </div>
    </div>
  );
}
