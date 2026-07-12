import type { ReactNode } from "react";
import { IconFiles, IconGitBranch } from "@tabler/icons-react";
import { cn } from "@/lib/utils";

export type SidebarTab = "files" | "changes";

interface TitleBarProps {
  /** Shown as the window title (left side, after the traffic lights). */
  title: string;
  activeTab: SidebarTab;
  gitAvailable: boolean;
  changeCount: number;
  onSelectTab: (tab: SidebarTab) => void;
}

// A custom overlay title bar. The window uses `titleBarStyle: "Overlay"` so the
// macOS traffic lights float at top-left over this bar; `pl-20` reserves room
// for them. `data-tauri-drag-region` makes the empty areas draggable.
export function TitleBar({
  title,
  activeTab,
  gitAvailable,
  changeCount,
  onSelectTab,
}: TitleBarProps) {
  return (
    <div
      data-tauri-drag-region
      className="flex h-9 shrink-0 select-none items-center border-b border-border bg-sidebar pr-2 pl-20"
    >
      <span
        data-tauri-drag-region
        className="min-w-0 truncate text-xs font-medium text-muted-foreground"
      >
        {title}
      </span>
      <div className="ml-auto flex items-center gap-0.5">
        <TabButton
          label="Files"
          active={activeTab === "files"}
          onClick={() => onSelectTab("files")}
        >
          <IconFiles className="size-4" stroke={1.75} />
        </TabButton>
        <TabButton
          label="Changes"
          active={activeTab === "changes"}
          disabled={!gitAvailable}
          badge={changeCount}
          onClick={() => onSelectTab("changes")}
        >
          <IconGitBranch className="size-4" stroke={1.75} />
        </TabButton>
      </div>
    </div>
  );
}

function TabButton({
  label,
  active,
  disabled = false,
  badge,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  disabled?: boolean;
  badge?: number;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "relative flex h-7 w-7 cursor-pointer items-center justify-center rounded-md transition-colors",
        active
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
        disabled &&
          "cursor-default opacity-40 hover:bg-transparent hover:text-muted-foreground",
      )}
    >
      {children}
      {badge != null && badge > 0 && (
        <span className="absolute -top-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-0.5 text-[9px] leading-none font-semibold text-primary-foreground">
          {badge}
        </span>
      )}
    </button>
  );
}
