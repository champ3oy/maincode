import { useCallback, useState, type JSX } from "react";
import { IconCheck, IconCopy } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { CommitAvatar } from "@/components/sidebar/commit-avatar";
import { cn } from "@/lib/utils";
import type { CommitDetails } from "@/lib/tauri";

interface CommitDetailHeaderProps {
  details: CommitDetails | "pending" | undefined;
  oid: string;
}

const DATE_FMT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

export function CommitDetailHeader(props: CommitDetailHeaderProps): JSX.Element {
  const { details, oid } = props;
  const shortSha = oid.slice(0, 7);

  const [copied, setCopied] = useState(false);
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(oid);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  }, [oid]);

  const hasDetails = details !== "pending" && details !== undefined;
  const body = hasDetails ? details.body : "";
  const hasBody = body.trim().length > 0;
  const lines = hasBody ? body.split(/\r?\n/) : [];
  const linesCount = lines.length;
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const expanded = userExpanded ?? linesCount <= 8;

  if (!hasDetails) {
    return (
      <div className="flex flex-col gap-3 px-4 py-3">
        <div className="flex items-start gap-3">
          <div className="size-10 shrink-0 rounded-full bg-muted animate-pulse" />
          <div className="min-w-0 flex-1 flex flex-col gap-1.5">
            <div className="h-3.5 w-32 rounded bg-muted animate-pulse" />
            <div className="h-3 w-48 rounded bg-muted animate-pulse" />
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <span className="font-mono text-xs px-2 py-1 rounded-md bg-muted text-muted-foreground">
              {shortSha}
            </span>
          </div>
        </div>
      </div>
    );
  }

  const dateString = DATE_FMT.format(new Date(details.author_timestamp * 1000));
  const subject = details.subject;

  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <div className="flex items-start gap-3">
        <CommitAvatar
          email={details.author_email}
          name={details.author_name}
          size={40}
        />
        <div className="min-w-0 flex-1 flex flex-col gap-0.5">
          <p className="truncate text-sm font-semibold text-foreground">
            {details.author_name}
          </p>
          <p className="truncate text-xs text-muted-foreground flex items-center gap-1.5">
            <span>{dateString}</span>
            <span className="opacity-50">•</span>
            <span className="truncate">{details.author_email}</span>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={copy}
            className={cn(
              "font-mono text-xs px-2 py-1 rounded-md bg-muted text-muted-foreground",
              "hover:bg-muted/80 hover:text-foreground transition-colors",
            )}
          >
            {shortSha}
          </button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={copy}
            aria-label="Copy commit SHA"
          >
            {copied ? (
              <IconCheck className="size-3.5" />
            ) : (
              <IconCopy className="size-3.5" />
            )}
          </Button>
        </div>
      </div>

      {(subject || hasBody) && (
        <div className="flex flex-col gap-2">
          {subject && (
            <p className="text-sm text-foreground">{subject}</p>
          )}
          {hasBody && (
            <>
              <pre className="whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground bg-muted/30 rounded-md px-3 py-2">
                {expanded ? body : lines.slice(0, 6).join("\n")}
              </pre>
              {linesCount > 8 && (
                <button
                  type="button"
                  onClick={() => setUserExpanded(!expanded)}
                  className="self-start text-xs text-foreground underline-offset-2 hover:underline"
                >
                  {expanded ? "Show less" : "Show more"}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
