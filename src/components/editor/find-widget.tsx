import { useEffect, useRef } from "react";
import {
  IconChevronDown,
  IconChevronRight,
  IconChevronUp,
  IconX,
} from "@tabler/icons-react";
import { cn } from "@/lib/utils";

export interface FindWidgetProps {
  open: boolean;
  showReplace: boolean;
  query: string;
  replace: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regexp: boolean;
  matchCurrent: number;
  matchTotal: number;
  matchCapped: boolean;
  setQuery: (v: string) => void;
  setReplace: (v: string) => void;
  toggleCase: () => void;
  toggleWord: () => void;
  toggleRegexp: () => void;
  toggleReplace: () => void;
  next: () => void;
  prev: () => void;
  replaceOne: () => void;
  replaceAllMatches: () => void;
  close: () => void;
}

export function FindWidget({
  open,
  showReplace,
  query,
  replace,
  caseSensitive,
  wholeWord,
  regexp,
  matchCurrent,
  matchTotal,
  matchCapped,
  setQuery,
  setReplace,
  toggleCase,
  toggleWord,
  toggleRegexp,
  toggleReplace,
  next,
  prev,
  replaceOne,
  replaceAllMatches,
  close,
}: FindWidgetProps) {
  const findInputRef = useRef<HTMLInputElement>(null);

  // Auto-focus the find input whenever the widget opens.
  useEffect(() => {
    if (open) {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    }
  }, [open]);

  if (!open) return null;

  const matchLabel = (() => {
    if (!query) return null;
    if (matchTotal === 0) return "No results";
    const totalStr = matchCapped ? `${matchTotal}+` : String(matchTotal);
    if (matchCurrent === 0) return `? / ${totalStr}`;
    return `${matchCurrent} / ${totalStr}`;
  })();

  return (
    <div
      className="absolute right-3 top-2 z-10 flex flex-col overflow-hidden rounded-lg border border-border bg-popover shadow-lg"
      style={{ minWidth: 340 }}
      // Prevent mouse events from reaching the editor beneath.
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* Find row */}
      <div className="flex h-9 items-center gap-1 px-1.5">
        {/* Expand/collapse replace row */}
        <button
          onClick={toggleReplace}
          title={showReplace ? "Collapse replace" : "Expand replace"}
          className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
        >
          <IconChevronRight
            className={cn("size-3.5 transition-transform", showReplace && "rotate-90")}
            stroke={2}
          />
        </button>

        {/* Find input */}
        <input
          ref={findInputRef}
          type="text"
          value={query}
          placeholder="Find"
          className="h-6 flex-1 rounded border border-border bg-background px-2 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-[#009fff]"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (e.shiftKey) prev();
              else next();
            } else if (e.key === "Escape") {
              e.preventDefault();
              close();
            }
          }}
          spellCheck={false}
          autoComplete="off"
        />

        {/* Toggle buttons: Aa / ab / .* */}
        <button
          onClick={toggleCase}
          title="Match Case"
          className={cn(
            "flex h-6 items-center rounded px-1.5 text-[11px] font-medium transition-colors",
            caseSensitive
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          Aa
        </button>
        <button
          onClick={toggleWord}
          title="Match Whole Word"
          className={cn(
            "flex h-6 items-center rounded px-1.5 text-[11px] font-medium transition-colors",
            wholeWord
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          ab
        </button>
        <button
          onClick={toggleRegexp}
          title="Use Regular Expression"
          className={cn(
            "flex h-6 items-center rounded px-1.5 text-[11px] font-medium transition-colors",
            regexp
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          .*
        </button>

        {/* Match count */}
        <span className="w-16 shrink-0 text-center text-[11px] text-muted-foreground tabular-nums">
          {matchLabel}
        </span>

        {/* Prev / Next */}
        <button
          onClick={prev}
          title="Previous Match (Shift+Enter)"
          className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
        >
          <IconChevronUp className="size-3.5" stroke={2} />
        </button>
        <button
          onClick={next}
          title="Next Match (Enter)"
          className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
        >
          <IconChevronDown className="size-3.5" stroke={2} />
        </button>

        {/* Close */}
        <button
          onClick={close}
          title="Close (Escape)"
          className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
        >
          <IconX className="size-3.5" stroke={2} />
        </button>
      </div>

      {/* Replace row (conditionally shown) */}
      {showReplace && (
        <div className="flex h-9 items-center gap-1 border-t border-border px-1.5">
          {/* Spacer to align with find input (chevron width) */}
          <span className="size-6 shrink-0" />

          {/* Replace input */}
          <input
            type="text"
            value={replace}
            placeholder="Replace"
            className="h-6 flex-1 rounded border border-border bg-background px-2 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-[#009fff]"
            onChange={(e) => setReplace(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                replaceOne();
              } else if (e.key === "Escape") {
                e.preventDefault();
                close();
              }
            }}
            spellCheck={false}
            autoComplete="off"
          />

          {/* Replace / Replace All buttons */}
          <button
            onClick={replaceOne}
            title="Replace next match"
            className="h-6 rounded border border-border bg-muted px-2 text-[11px] text-foreground hover:bg-accent hover:text-accent-foreground transition-colors whitespace-nowrap"
          >
            Replace
          </button>
          <button
            onClick={replaceAllMatches}
            title="Replace all matches"
            className="h-6 rounded border border-border bg-muted px-2 text-[11px] text-foreground hover:bg-accent hover:text-accent-foreground transition-colors whitespace-nowrap"
          >
            All
          </button>
        </div>
      )}
    </div>
  );
}
