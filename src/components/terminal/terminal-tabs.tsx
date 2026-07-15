import { IconPlus, IconX } from "@tabler/icons-react";
import { cn } from "@/lib/utils";

export interface TerminalTab {
  id: number;
  title: string;
}

interface TerminalTabsProps {
  tabs: TerminalTab[];
  activeId: number;
  onActivate: (id: number) => void;
  onClose: (id: number) => void;
  onAdd: () => void;
}

// Horizontal tab strip for the terminal dock. Renders the same in both dock
// positions (it lives at the top of the dock); scrolls horizontally on overflow.
export function TerminalTabs({ tabs, activeId, onActivate, onClose, onAdd }: TerminalTabsProps) {
  return (
    <div className="flex min-w-0 items-center gap-0.5 overflow-x-auto">
      {tabs.map((t) => {
        const active = t.id === activeId;
        return (
          <div
            key={t.id}
            role="tab"
            aria-selected={active}
            aria-label={t.title}
            tabIndex={0}
            onClick={() => onActivate(t.id)}
            className={cn(
              "group flex shrink-0 cursor-pointer items-center gap-1.5 rounded px-2 py-0.5 text-xs",
              active ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-muted/40",
            )}
          >
            <span className="max-w-32 truncate">{t.title}</span>
            <button
              type="button"
              aria-label={`Close ${t.title}`}
              onClick={(e) => { e.stopPropagation(); onClose(t.id); }}
              className="flex size-4 items-center justify-center rounded opacity-0 hover:bg-muted group-hover:opacity-100"
            >
              <IconX className="size-3" />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        aria-label="New terminal"
        title="New terminal"
        onClick={onAdd}
        className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <IconPlus className="size-3.5" />
      </button>
    </div>
  );
}
