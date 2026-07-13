// src/components/command-center/command-center.tsx
import { useState } from "react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  IconFile,
  IconFolder,
  IconCommand,
} from "@tabler/icons-react";
import type { RecentRepo } from "@/hooks/use-recent-repos";

export interface PaletteCommand {
  id: string;
  label: string;
  run: () => void;
}

interface CommandCenterProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Workspace-relative file paths for quick open. */
  files: string[];
  onOpenFile: (relativePath: string) => void;
  commands: PaletteCommand[];
  /** Recently opened project folders. */
  recent: RecentRepo[];
  onOpenRecent: (path: string) => void;
}

type Tab = "all" | "files" | "recent" | "commands";

const TABS: { id: Tab; label: string }[] = [
  { id: "all", label: "All" },
  { id: "files", label: "Files" },
  { id: "recent", label: "Recent" },
  { id: "commands", label: "Commands" },
];

/** Extract the last path segment as a display name. */
function basename(p: string): string {
  return p.replace(/\/$/, "").split("/").pop() ?? p;
}

/** Format a timestamp (ms) as a human-friendly relative string. */
function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function CommandCenter({
  open,
  onOpenChange,
  files,
  onOpenFile,
  commands,
  recent,
  onOpenRecent,
}: CommandCenterProps) {
  const [tab, setTab] = useState<Tab>("all");

  const showFiles = tab === "all" || tab === "files";
  const showRecent = tab === "all" || tab === "recent";
  const showCommands = tab === "all" || tab === "commands";

  function close() {
    onOpenChange(false);
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Command Center"
      description="Search files, recent projects, and commands"
      className="w-[560px] max-w-[90vw]"
    >
      {/* Search input */}
      <CommandInput placeholder="Search files, recent, commands…" />

      {/* Tab row */}
      <div className="flex gap-1 border-b border-border px-2 pb-1 pt-1">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={
              tab === id
                ? "rounded-md bg-muted px-2.5 py-0.5 text-xs font-medium text-foreground"
                : "rounded-md px-2.5 py-0.5 text-xs font-medium text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            }
          >
            {label}
          </button>
        ))}
      </div>

      {/* Results */}
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>

        {showFiles && files.length > 0 && (
          <CommandGroup heading="Files">
            {files.map((f) => (
              <CommandItem
                key={f}
                value={`file ${f}`}
                onSelect={() => {
                  close();
                  onOpenFile(f);
                }}
              >
                <IconFile className="mr-2 size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{f}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {showRecent && recent.length > 0 && (
          <CommandGroup heading="Recent">
            {recent.map((r) => (
              <CommandItem
                key={r.path}
                value={`recent ${basename(r.path)} ${r.path}`}
                onSelect={() => {
                  close();
                  onOpenRecent(r.path);
                }}
              >
                <IconFolder className="mr-2 size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{basename(r.path)}</span>
                <span className="ml-3 shrink-0 text-xs text-muted-foreground">
                  {relativeTime(r.addedAt)}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {showCommands && commands.length > 0 && (
          <CommandGroup heading="Commands">
            {commands.map((cmd) => (
              <CommandItem
                key={cmd.id}
                value={`cmd ${cmd.label}`}
                onSelect={() => {
                  close();
                  cmd.run();
                }}
              >
                <IconCommand className="mr-2 size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{cmd.label}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>

      {/* Footer hints */}
      <div className="flex items-center gap-3 border-t border-border px-3 py-1.5 text-xs text-muted-foreground">
        <span><kbd className="font-sans">↑↓</kbd> navigate</span>
        <span><kbd className="font-sans">↵</kbd> open</span>
        <span><kbd className="font-sans">Esc</kbd> close</span>
      </div>
    </CommandDialog>
  );
}
