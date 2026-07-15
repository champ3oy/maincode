import { IconArrowUpCircle } from "@tabler/icons-react";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { useUpdateCheck } from "@/hooks/use-update-check";

export function UpdateIndicator() {
  const { status, version, notes, progress, install } = useUpdateCheck();
  if (status === "idle") return null;
  return (
    <Popover>
      <PopoverTrigger
        aria-label="Update available"
        title="Update available"
        className="flex h-7 items-center gap-1 rounded-md px-1.5 text-xs text-primary hover:bg-muted/40"
      >
        <IconArrowUpCircle className="size-4" stroke={1.75} />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 text-sm">
        <p className="font-medium">Update available{version ? ` — ${version}` : ""}</p>
        {notes && <p className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap text-xs text-muted-foreground">{notes}</p>}
        {status === "downloading" ? (
          <p className="mt-3 text-xs text-muted-foreground">Downloading… {progress ?? 0}%</p>
        ) : status === "error" ? (
          <p className="mt-3 text-xs text-destructive">Update failed — try again later.</p>
        ) : (
          <button
            type="button"
            onClick={() => void install()}
            className="mt-3 w-full rounded border border-border px-2.5 py-1 text-xs hover:bg-accent"
          >
            Update &amp; Restart
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}
