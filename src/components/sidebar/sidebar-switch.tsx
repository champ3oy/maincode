import { cn } from "@/lib/utils";

export type SidebarTab = "files" | "changes";

interface SidebarSwitchProps {
  active: SidebarTab;
  changeCount: number;
  gitAvailable: boolean;
  onSelect: (tab: SidebarTab) => void;
}

const TABS: ReadonlyArray<{ id: SidebarTab; label: string }> = [
  { id: "files", label: "Files" },
  { id: "changes", label: "Changes" },
];

export function SidebarSwitch({
  active,
  changeCount,
  gitAvailable,
  onSelect,
}: SidebarSwitchProps) {
  return (
    <div className="flex h-10 w-full items-center gap-1 border-b border-border bg-sidebar px-1.5">
      {TABS.map((tab) => {
        const isActive = active === tab.id;
        const disabled = tab.id === "changes" && !gitAvailable;
        return (
          <button
            key={tab.id}
            type="button"
            disabled={disabled}
            onClick={() => onSelect(tab.id)}
            className={cn(
              "h-7 flex-1 cursor-pointer rounded-md text-xs font-medium transition-colors",
              isActive
                ? "bg-accent text-accent-foreground shadow-sm"
                : "bg-transparent text-muted-foreground hover:bg-muted/40 hover:text-foreground",
              disabled && "cursor-default opacity-40",
            )}
          >
            {tab.label}
            {tab.id === "changes" && changeCount > 0 && (
              <span className="text-muted-foreground ml-1.5 text-[10px]">
                {changeCount}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
