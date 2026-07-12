import { IconFolderOpen, IconX } from "@tabler/icons-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { useRecentRepos } from "@/hooks/use-recent-repos";
import { basename } from "@/hooks/use-workspace";

interface WelcomeProps {
  onOpenFolder: (path: string) => void;
}

export function Welcome({ onOpenFolder }: WelcomeProps) {
  const { recent, removeRecent } = useRecentRepos();

  const handleBrowse = async () => {
    const selected = await openDialog({ directory: true, multiple: false });
    if (typeof selected === "string") onOpenFolder(selected);
  };

  return (
    <main className="flex h-dvh flex-col items-center justify-center gap-6 bg-background">
      <div className="text-center">
        <h1 className="text-2xl font-semibold">Maincode</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          A simple code editor
        </p>
      </div>
      <Button onClick={handleBrowse}>
        <IconFolderOpen className="size-4" />
        Open Folder
      </Button>
      {recent.length > 0 && (
        <div className="w-72">
          <p className="text-muted-foreground mb-2 text-xs font-medium uppercase tracking-wide">
            Recent
          </p>
          <ul className="flex flex-col gap-1">
            {recent.map((r) => (
              <li
                key={r.path}
                className="group flex items-center justify-between gap-2"
              >
                <button
                  type="button"
                  title={r.path}
                  className="cursor-pointer truncate text-sm hover:underline"
                  onClick={() => onOpenFolder(r.path)}
                >
                  {basename(r.path)}
                </button>
                <button
                  type="button"
                  className="cursor-pointer opacity-0 transition-opacity group-hover:opacity-100"
                  onClick={() => removeRecent(r.path)}
                >
                  <IconX className="text-muted-foreground size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </main>
  );
}
