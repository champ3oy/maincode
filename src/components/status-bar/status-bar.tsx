import { useEffect, useMemo, useState } from "react";
import { useTheme } from "next-themes";
import {
  IconCheck,
  IconFolder,
  IconFolderOpen,
  IconGitBranch,
  IconSettings,
  IconPlus,
  IconMinus,
} from "@tabler/icons-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  FONT_LABELS,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  useDiffSettings,
  type FontChoice,
} from "@/hooks/use-diff-settings";
import { useRecentRepos } from "@/hooks/use-recent-repos";
import { useRecentBranches } from "@/hooks/use-recent-branches";
import {
  checkoutBranch,
  listBranches,
  type BranchInfo,
} from "@/lib/tauri";
import { cn } from "@/lib/utils";

interface StatusBarProps {
  workdir: string;
  branch: string | null;
  onOpenRepo: (path: string) => Promise<string>;
  onBranchSwitched: () => void | Promise<void>;
}

function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

export function StatusBar({
  workdir,
  branch,
  onOpenRepo,
  onBranchSwitched,
}: StatusBarProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <>
      <footer className="flex h-7 shrink-0 items-center gap-1 border-t border-border bg-muted/40 px-2 text-xs text-muted-foreground">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Settings"
          title="Settings"
          onClick={() => setSettingsOpen(true)}
        >
          <IconSettings />
        </Button>

        <div className="ml-auto flex items-center gap-1">
          <ProjectSegment workdir={workdir} onOpenRepo={onOpenRepo} />
          <BranchSegment
            branch={branch}
            onBranchSwitched={onBranchSwitched}
          />
        </div>
      </footer>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </>
  );
}

function ProjectSegment({
  workdir,
  onOpenRepo,
}: {
  workdir: string;
  onOpenRepo: (path: string) => Promise<string>;
}) {
  const [open, setOpen] = useState(false);
  const { recent } = useRecentRepos();
  const recentPaths = useMemo(() => recent.map((r) => r.path), [recent]);
  const branchByPath = useRecentBranches(recentPaths);
  const others = useMemo(
    () => recent.filter((r) => r.path !== workdir),
    [recent, workdir],
  );

  const switchTo = async (path: string) => {
    setOpen(false);
    try {
      await onOpenRepo(path);
    } catch (e) {
      toast.error(`Failed to open: ${e}`);
    }
  };

  const handleOpenLocal = async () => {
    setOpen(false);
    try {
      const selected = await openDialog({ directory: true, multiple: false });
      if (typeof selected !== "string") return;
      await onOpenRepo(selected);
    } catch (e) {
      toast.error(`Open failed: ${e}`);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="flex items-center gap-1.5 rounded px-1.5 py-0.5 transition-colors hover:bg-accent hover:text-accent-foreground"
            title="Switch project"
          />
        }
      >
        <IconFolder className="size-3.5" />
        <span className="font-medium">{basename(workdir)}</span>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={6}
        className="w-72 p-0"
      >
        <div className="flex flex-col">
          <div className="px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Recent projects
          </div>
          <ul className="flex max-h-64 flex-col overflow-y-auto px-1 pb-1">
            {others.length === 0 ? (
              <li className="px-2 py-1.5 text-xs text-muted-foreground">
                No other recent projects.
              </li>
            ) : (
              others.map((r) => {
                const b = branchByPath[r.path];
                return (
                  <li key={r.path}>
                    <button
                      type="button"
                      onClick={() => switchTo(r.path)}
                      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent"
                    >
                      <IconFolder className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate font-medium">
                        {basename(r.path)}
                      </span>
                      <span className="ml-auto shrink-0 truncate font-mono text-[11px] text-muted-foreground">
                        {b === undefined ? "" : b ?? "—"}
                      </span>
                    </button>
                  </li>
                );
              })
            )}
          </ul>
          <div className="border-t border-border p-1">
            <button
              type="button"
              onClick={handleOpenLocal}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent"
            >
              <IconFolderOpen className="size-3.5 text-muted-foreground" />
              Open other repository...
            </button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function BranchSegment({
  branch,
  onBranchSwitched,
}: {
  branch: string | null;
  onBranchSwitched: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<BranchInfo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    listBranches()
      .then((list) => {
        if (cancelled) return;
        setBranches(list);
      })
      .catch((e) => {
        if (cancelled) return;
        toast.error(`Failed to list branches: ${e}`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, branch]);

  const handleSwitch = async (name: string) => {
    if (switching) return;
    setSwitching(name);
    try {
      await checkoutBranch(name);
      setOpen(false);
      await onBranchSwitched();
    } catch (e) {
      toast.error(`Checkout failed: ${e}`);
    } finally {
      setSwitching(null);
    }
  };

  if (!branch) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="flex items-center gap-1.5 rounded px-1.5 py-0.5 transition-colors hover:bg-accent hover:text-accent-foreground"
            title="Switch branch"
          />
        }
      >
        <IconGitBranch className="size-3.5" />
        <span className="font-mono">{branch}</span>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={6}
        className="w-64 p-0"
      >
        <div className="flex flex-col">
          <div className="px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Switch branch
          </div>
          <ul className="flex max-h-64 flex-col overflow-y-auto px-1 pb-1">
            {loading && branches == null ? (
              <li className="px-2 py-1.5 text-xs text-muted-foreground">
                Loading...
              </li>
            ) : branches && branches.length === 0 ? (
              <li className="px-2 py-1.5 text-xs text-muted-foreground">
                No local branches.
              </li>
            ) : (
              branches?.map((b) => (
                <li key={b.name}>
                  <button
                    type="button"
                    disabled={switching != null}
                    onClick={() => handleSwitch(b.name)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left font-mono text-sm transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60",
                      b.is_current && "text-foreground",
                    )}
                  >
                    <IconCheck
                      className={cn(
                        "size-3.5 shrink-0",
                        b.is_current ? "opacity-100" : "opacity-0",
                      )}
                    />
                    <span className="truncate">{b.name}</span>
                    {switching === b.name && (
                      <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                        Switching...
                      </span>
                    )}
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { theme, setTheme } = useTheme();
  const { settings, setFont, setFontSize, setWrap } = useDiffSettings();
  const { font, fontSize, wrap } = settings;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Configure how cub looks and behaves.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              Theme
            </span>
            <div className="flex gap-1">
              {(["system", "light", "dark"] as const).map((t) => (
                <Button
                  key={t}
                  variant={theme === t ? "default" : "outline"}
                  size="sm"
                  onClick={() => setTheme(t)}
                  className="flex-1 capitalize"
                >
                  {t}
                </Button>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              Diff font
            </span>
            <Select
              value={font}
              onValueChange={(v) => setFont(v as FontChoice)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(FONT_LABELS) as FontChoice[]).map((f) => (
                  <SelectItem key={f} value={f}>
                    {FONT_LABELS[f]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              Diff font size
            </span>
            <div className="flex h-8 items-center gap-1">
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="Decrease font size"
                disabled={fontSize <= FONT_SIZE_MIN}
                onClick={() => setFontSize(fontSize - 1)}
              >
                <IconMinus />
              </Button>
              <span className="w-14 text-center text-sm tabular-nums">
                {fontSize}px
              </span>
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="Increase font size"
                disabled={fontSize >= FONT_SIZE_MAX}
                onClick={() => setFontSize(fontSize + 1)}
              >
                <IconPlus />
              </Button>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              Line wrapping
            </span>
            <div className="flex h-8 items-center gap-2">
              <Switch
                checked={wrap}
                onCheckedChange={setWrap}
                size="sm"
                aria-label="Wrap long lines"
              />
              <span className="text-sm text-muted-foreground">
                {wrap ? "Wrap long lines" : "Scroll horizontally"}
              </span>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
