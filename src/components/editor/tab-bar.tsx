import { IconX } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { isDirty, type EditorTab } from "@/hooks/editor-tabs-reducer";

interface TabBarProps {
  tabs: EditorTab[];
  activePath: string | null;
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
}

export function TabBar({ tabs, activePath, onActivate, onClose }: TabBarProps) {
  if (tabs.length === 0) return null;
  return (
    <div className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-border bg-sidebar">
      {tabs.map((tab) => {
        const active = tab.path === activePath;
        return (
          <div
            key={tab.path}
            title={tab.path}
            className={cn(
              "group flex cursor-pointer items-center gap-1.5 border-r border-border px-3 text-xs",
              active
                ? "bg-background text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => onActivate(tab.path)}
          >
            <span className="max-w-40 truncate">{tab.name}</span>
            {isDirty(tab) && (
              <span className="size-1.5 shrink-0 rounded-full bg-amber-500" />
            )}
            <button
              type="button"
              className="cursor-pointer rounded-sm p-0.5 opacity-0 transition-opacity hover:bg-muted group-hover:opacity-100"
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.path);
              }}
            >
              <IconX className="size-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
