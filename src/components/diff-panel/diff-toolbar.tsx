import { Button } from "@/components/ui/button";
import {
  IconArrowLeft,
  IconArrowsVertical,
  IconCheck,
  IconFold,
  IconLayoutColumns,
  IconLayoutRows,
} from "@tabler/icons-react";
import { DIFF_ADDITION_COLOR, DIFF_DELETION_COLOR } from "@/lib/status";

interface BranchInfo {
  baseRef: string;
  additions: number;
  deletions: number;
  onBack: () => void;
}

interface DiffToolbarProps {
  diffStyle: "unified" | "split";
  onDiffStyleChange: (style: "unified" | "split") => void;
  allExpanded: boolean;
  onToggleExpandAll: () => void;
  commentCount?: number;
  pendingCount?: number;
  acknowledgedCount?: number;
  resolvedCount?: number;
  onSubmitReview?: () => void;
  onClearResolved?: () => void;
  submittingReview?: boolean;
  branchInfo?: BranchInfo;
  readOnly?: boolean;
}

function StatusSummary({
  pending,
  acknowledged,
  resolved,
}: {
  pending: number;
  acknowledged: number;
  resolved: number;
}) {
  const parts: string[] = [];
  if (pending > 0) parts.push(`${pending} pending`);
  if (acknowledged > 0) parts.push(`${acknowledged} reviewing`);
  if (resolved > 0) parts.push(`${resolved} resolved`);
  if (parts.length === 0) return null;
  return (
    <p className="text-xs text-muted-foreground tabular-nums">
      {parts.join(" · ")}
    </p>
  );
}

export function DiffToolbar({
  diffStyle,
  onDiffStyleChange,
  allExpanded,
  onToggleExpandAll,
  commentCount = 0,
  pendingCount = 0,
  acknowledgedCount = 0,
  resolvedCount = 0,
  onSubmitReview,
  onClearResolved,
  submittingReview = false,
  branchInfo,
  readOnly = false,
}: DiffToolbarProps) {
  return (
    <div className="sticky top-0 z-10 flex h-10 shrink-0 items-center gap-2 border-b border-border bg-background px-3">
      {branchInfo ? (
        <>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={branchInfo.onBack}
            aria-label="Back to changes"
            title="Back to changes"
          >
            <IconArrowLeft className="size-3.5" />
          </Button>
          <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            Changes since {branchInfo.baseRef}
          </p>
          {(branchInfo.additions > 0 || branchInfo.deletions > 0) && (
            <div className="flex shrink-0 items-center gap-1.5 text-xs tabular-nums">
              {branchInfo.additions > 0 && (
                <span className={DIFF_ADDITION_COLOR}>
                  +{branchInfo.additions}
                </span>
              )}
              {branchInfo.deletions > 0 && (
                <span className={DIFF_DELETION_COLOR}>
                  −{branchInfo.deletions}
                </span>
              )}
            </div>
          )}
        </>
      ) : !readOnly ? (
        <StatusSummary
          pending={pendingCount}
          acknowledged={acknowledgedCount}
          resolved={resolvedCount}
        />
      ) : null}
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {!readOnly && resolvedCount > 0 && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground"
            onClick={onClearResolved}
            title="Clear resolved"
          >
            <IconCheck className="size-3.5" />
          </Button>
        )}
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
        {!readOnly && (
          <Button
            size="sm"
            disabled={commentCount === 0 || submittingReview}
            onClick={onSubmitReview}
            className="tabular-nums"
          >
            {submittingReview
              ? "Submitting…"
              : commentCount > 0
                ? `Submit (${commentCount})`
                : "Submit Review"}
          </Button>
        )}
      </div>
    </div>
  );
}
