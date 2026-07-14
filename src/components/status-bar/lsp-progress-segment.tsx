import { useEffect, useState } from "react";
import { IconLoader2 } from "@tabler/icons-react";
import { onLspProgress, type LspProgressEvent } from "@/lib/intelligence";

/** Friendly server display names (fall back to the raw id). */
const SERVER_LABEL: Record<string, string> = {
  rust: "rust-analyzer",
  typescript: "tsserver",
  python: "pyright",
  go: "gopls",
  cpp: "clangd",
};

/** Status-bar segment showing live language-server progress (e.g. rust-analyzer
 *  indexing) so a slow first index reads as "working", not "frozen". Renders
 *  nothing when no server is reporting progress. */
export function LspProgressSegment() {
  const [progress, setProgress] = useState<LspProgressEvent | null>(null);
  useEffect(() => onLspProgress(setProgress), []);

  if (!progress) return null;
  const label = SERVER_LABEL[progress.serverId] ?? progress.serverId;
  const title = progress.title || "working";
  const pct =
    typeof progress.percentage === "number" ? ` ${Math.round(progress.percentage)}%` : "";

  return (
    <span className="flex items-center gap-1.5" title={progress.message ?? title}>
      <IconLoader2 className="size-3.5 animate-spin" />
      <span>
        {label}: {title}
        {pct}
      </span>
    </span>
  );
}
