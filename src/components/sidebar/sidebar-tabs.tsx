import { cn } from "@/lib/utils";

interface SidebarTabsProps {
  active: "changes" | "history";
  disabled?: boolean;
  hasUncommittedChanges: boolean;
  onSelect: (tab: "changes" | "history") => void;
  onPrefetchHistory?: () => void;
}

const TABS: ReadonlyArray<{ id: "changes" | "history"; label: string }> = [
  { id: "changes", label: "Changes" },
  { id: "history", label: "History" },
];

export function SidebarTabs({
  active,
  disabled = false,
  hasUncommittedChanges,
  onSelect,
  onPrefetchHistory,
}: SidebarTabsProps) {
  return (
    <div
      role="tablist"
      className="flex h-10 w-full items-center gap-1 border-b border-border bg-sidebar px-1.5"
    >
      {TABS.map((tab) => {
        const isActive = active === tab.id;
        const showDot =
          tab.id === "changes" &&
          active === "history" &&
          hasUncommittedChanges;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-label={tab.label}
            onPointerEnter={tab.id === "history" ? onPrefetchHistory : undefined}
            onFocus={tab.id === "history" ? onPrefetchHistory : undefined}
            onClick={() => onSelect(tab.id)}
            className={cn(
              "flex-1 rounded-md text-xs font-medium h-7 transition-colors cursor-pointer",
              isActive
                ? "bg-accent text-accent-foreground shadow-sm"
                : "bg-transparent text-muted-foreground hover:text-foreground hover:bg-muted/40",
              disabled && "opacity-40",
            )}
          >
            {tab.label}
            {showDot && (
              <span className="ml-1.5 inline-block size-1.5 rounded-full bg-amber-500" />
            )}
          </button>
        );
      })}
    </div>
  );
}
