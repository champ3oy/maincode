import { Button } from "@/components/ui/button";
import {
  IconArrowsVertical,
  IconFold,
  IconLayoutColumns,
  IconLayoutRows,
} from "@tabler/icons-react";

interface DiffToolbarProps {
  diffStyle: "unified" | "split";
  onDiffStyleChange: (style: "unified" | "split") => void;
  allExpanded: boolean;
  onToggleExpandAll: () => void;
}

export function DiffToolbar({
  diffStyle,
  onDiffStyleChange,
  allExpanded,
  onToggleExpandAll,
}: DiffToolbarProps) {
  return (
    <div className="sticky top-0 z-10 flex h-10 shrink-0 items-center gap-2 border-b border-border bg-background px-3">
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onToggleExpandAll}
          title={allExpanded ? "Collapse All" : "Expand All"}
        >
          {allExpanded ? (
            <IconFold className="size-3.5" />
          ) : (
            <IconArrowsVertical className="size-3.5" />
          )}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() =>
            onDiffStyleChange(diffStyle === "split" ? "unified" : "split")
          }
          title={diffStyle === "split" ? "Switch to unified" : "Switch to split"}
        >
          {diffStyle === "split" ? (
            <IconLayoutColumns className="size-3.5" />
          ) : (
            <IconLayoutRows className="size-3.5" />
          )}
        </Button>
      </div>
    </div>
  );
}
