import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { IconLayoutBottombar, IconLayoutSidebarRight } from "@tabler/icons-react";
import { TerminalPanel } from "./terminal-panel";
import { TerminalTabs, type TerminalTab } from "./terminal-tabs";

export type TerminalPosition = "bottom" | "right";

export interface TerminalDockHandle {
  openTerminalWithCommand: (command: string, title: string) => void;
}

interface TerminalDockProps {
  cwd: string;
  /** Where the dock is docked; controls how multiple terminals split. */
  position: TerminalPosition;
  onTogglePosition: () => void;
  /** Called when the last terminal is closed, so the panel can hide. */
  onEmpty: () => void;
}

interface TermEntry extends TerminalTab {
  command?: string;
}

// Hosts terminals as tabs. All panels stay mounted; inactive ones are hidden
// (display:none) so their shell + scrollback survive tab switches.
export const TerminalDock = forwardRef<TerminalDockHandle, TerminalDockProps>(
  function TerminalDock({ cwd, position, onTogglePosition, onEmpty }, ref) {
    const nextId = useRef(1);
    const [terminals, setTerminals] = useState<TermEntry[]>([
      { id: 0, title: "zsh" },
    ]);
    const [activeId, setActiveId] = useState(0);

    const addTerminal = useCallback((command?: string, title = "zsh") => {
      const id = nextId.current++;
      setTerminals((prev) => [...prev, { id, title, command }]);
      setActiveId(id);
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        openTerminalWithCommand: (command: string, title: string) =>
          addTerminal(command, title),
      }),
      [addTerminal],
    );

    const closeTerminal = useCallback(
      (id: number) => {
        setTerminals((prev) => {
          const next = prev.filter((t) => t.id !== id);
          if (next.length === 0) {
            onEmpty();
          } else {
            setActiveId((cur) =>
              cur === id ? next[next.length - 1].id : cur,
            );
          }
          return next;
        });
      },
      [onEmpty],
    );

    return (
      <div className="flex h-full flex-col bg-background">
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-2">
          <TerminalTabs
            tabs={terminals}
            activeId={activeId}
            onActivate={setActiveId}
            onClose={closeTerminal}
            onAdd={() => addTerminal()}
          />
          <button
            type="button"
            title={
              position === "bottom"
                ? "Move terminal to the side"
                : "Move terminal to the bottom"
            }
            onClick={onTogglePosition}
            className="ml-auto flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {position === "bottom" ? (
              <IconLayoutSidebarRight className="size-3.5" />
            ) : (
              <IconLayoutBottombar className="size-3.5" />
            )}
          </button>
        </div>
        <div className="relative min-h-0 flex-1">
          {terminals.map((t) => (
            <div
              key={t.id}
              className={t.id === activeId ? "absolute inset-0" : "hidden"}
            >
              <TerminalPanel
                cwd={cwd}
                active={t.id === activeId}
                command={t.command}
              />
            </div>
          ))}
        </div>
      </div>
    );
  },
);
