import { memo } from "react";
import { formatDistanceToNowStrict } from "date-fns";
import { cn } from "@/lib/utils";
import type { CommitDetails } from "@/lib/tauri";
import { CommitAvatar } from "./commit-avatar";

interface CommitRowProps {
  oid: string;
  details: CommitDetails | "pending" | undefined;
  selected: boolean;
  onSelect: (oid: string) => void;
}

function CommitRowImpl({
  oid,
  details,
  selected,
  onSelect,
}: CommitRowProps) {
  const resolved = details && details !== "pending" ? details : null;
  const subject = resolved?.subject ?? "…";
  const authorName = resolved?.author_name ?? "";
  const authorEmail = resolved?.author_email ?? "";
  const relative = resolved
    ? formatDistanceToNowStrict(new Date(resolved.author_timestamp * 1000), {
        addSuffix: true,
      })
    : "—";
  const shortSha = oid.slice(0, 7);

  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={() => onSelect(oid)}
      className={cn(
        "flex w-full cursor-pointer items-start gap-2.5 px-3 py-2 text-left",
        selected
          ? "bg-accent text-accent-foreground"
          : "hover:bg-muted/40",
      )}
    >
      <CommitAvatar
        email={resolved ? authorEmail : ""}
        name={resolved ? authorName : "?"}
        size={28}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p
          className={cn(
            "truncate text-sm font-medium leading-tight",
            selected ? "text-accent-foreground" : "text-foreground",
          )}
        >
          {subject}
        </p>
        <p
          className={cn(
            "flex items-center gap-1 truncate text-xs",
            selected
              ? "text-accent-foreground/80"
              : "text-muted-foreground",
          )}
        >
          <span className="truncate">{authorName || "—"}</span>
          <span>·</span>
          <span className="shrink-0">{relative}</span>
          <span>·</span>
          <span className="shrink-0 font-mono">{shortSha}</span>
        </p>
      </div>
    </button>
  );
}

export const CommitRow = memo(CommitRowImpl);
