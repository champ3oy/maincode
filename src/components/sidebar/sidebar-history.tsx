import { useCallback, useEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Button } from "@/components/ui/button";
import { IconArrowLeft } from "@tabler/icons-react";
import type { CommitHistoryState } from "@/hooks/use-commit-history";
import { useCommitDetailsCache } from "@/hooks/use-commit-details-cache";
import { CommitRow } from "./commit-row";

interface SidebarHistoryProps {
  workdir: string | null;
  selectedOid: string | null;
  onSelectOid: (oid: string) => void;
  onCloseRepo: () => void;
  history: CommitHistoryState;
  onPrefetchOid?: (oid: string) => void;
}

const PREFETCH_RADIUS = 50;
const ROW_HEIGHT = 68;
const HOVER_PREFETCH_DELAY_MS = 60;

// Zed-style overlay scrollbar: thin, semi-transparent, fades in on hover.
// Tailwind doesn't ship thumb utilities, so we inline the webkit + standard
// CSS via arbitrary variants on the scroll container.
const SCROLLBAR_CLASS =
  "[scrollbar-width:thin] [scrollbar-color:transparent_transparent] hover:[scrollbar-color:var(--border)_transparent] " +
  "[&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent " +
  "[&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-transparent " +
  "[&::-webkit-scrollbar-thumb]:transition-colors " +
  "hover:[&::-webkit-scrollbar-thumb]:bg-border/60 " +
  "[&::-webkit-scrollbar-thumb:hover]:bg-muted-foreground/40";

export function SidebarHistory({
  workdir,
  selectedOid,
  onSelectOid,
  onCloseRepo,
  history,
  onPrefetchOid,
}: SidebarHistoryProps) {
  const { oids, loaded, total, done, error } = history;
  const { requestVisible, getDetails } = useCommitDetailsCache();

  const parentRef = useRef<HTMLDivElement | null>(null);
  const hoverPrefetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const cancelHoverPrefetch = useCallback(() => {
    if (hoverPrefetchTimerRef.current === null) return;
    clearTimeout(hoverPrefetchTimerRef.current);
    hoverPrefetchTimerRef.current = null;
  }, []);

  const scheduleHoverPrefetch = useCallback(
    (oid: string) => {
      if (!onPrefetchOid) return;
      cancelHoverPrefetch();
      hoverPrefetchTimerRef.current = setTimeout(() => {
        hoverPrefetchTimerRef.current = null;
        onPrefetchOid(oid);
      }, HOVER_PREFETCH_DELAY_MS);
    },
    [cancelHoverPrefetch, onPrefetchOid],
  );

  useEffect(() => cancelHoverPrefetch, [cancelHoverPrefetch]);

  const virtualizer = useVirtualizer({
    count: done ? oids.length : oids.length + 1,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const firstIndex = virtualItems.length > 0 ? virtualItems[0].index : 0;
  const lastIndex =
    virtualItems.length > 0
      ? virtualItems[virtualItems.length - 1].index
      : -1;

  // Prefetch a window of commit details around the visible range.
  useEffect(() => {
    if (oids.length === 0 || virtualItems.length === 0) return;
    const start = Math.max(0, firstIndex - PREFETCH_RADIUS);
    const end = Math.min(oids.length - 1, lastIndex + PREFETCH_RADIUS);
    const slice: string[] = [];
    for (let i = start; i <= end; i++) slice.push(oids[i]);
    requestVisible(slice);
  }, [oids, firstIndex, lastIndex, virtualItems.length, requestVisible]);

  // Auto-select HEAD once when nothing is selected.
  const autoSelectedRef = useRef(false);
  useEffect(() => {
    if (autoSelectedRef.current) return;
    if (selectedOid !== null) {
      autoSelectedRef.current = true;
      return;
    }
    if (oids.length === 0) return;
    autoSelectedRef.current = true;
    onSelectOid(oids[0]);
  }, [oids, selectedOid, onSelectOid]);

  // Reset auto-select guard when the workdir changes so a new repo can
  // auto-select its HEAD on first load.
  useEffect(() => {
    autoSelectedRef.current = false;
  }, [workdir]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (oids.length === 0) return;
      const currentIdx =
        selectedOid !== null ? oids.indexOf(selectedOid) : -1;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        const next =
          currentIdx < 0 ? 0 : Math.min(oids.length - 1, currentIdx + 1);
        if (next !== currentIdx) {
          onSelectOid(oids[next]);
          virtualizer.scrollToIndex(next);
        }
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        const next = currentIdx <= 0 ? 0 : currentIdx - 1;
        if (next !== currentIdx) {
          onSelectOid(oids[next]);
          virtualizer.scrollToIndex(next);
        }
      } else if (event.key === "Enter" || event.key === " ") {
        if (currentIdx >= 0) {
          event.preventDefault();
          onSelectOid(oids[currentIdx]);
        }
      }
    },
    [oids, selectedOid, onSelectOid, virtualizer],
  );

  const repoName = useMemo(
    () => workdir?.replace(/\/+$/, "").split("/").pop() ?? "No repository",
    [workdir],
  );

  const visibleCount = total ?? loaded;
  const counterLabel =
    total !== null || done
      ? `${visibleCount} commit${visibleCount === 1 ? "" : "s"}`
      : "Loading…";

  return (
    <div className="flex h-full w-full min-w-0 flex-col">
      <div className="flex h-10 items-center gap-1 border-b border-border px-1.5">
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onCloseRepo}
          aria-label="Back to onboarding"
          title="Open a different repository"
        >
          <IconArrowLeft />
        </Button>
        <p className="min-w-0 flex-1 truncate text-sm font-medium text-sidebar-foreground">
          {repoName}
        </p>
        <p className="shrink-0 pr-1 text-xs tabular-nums text-muted-foreground">
          {counterLabel}
        </p>
      </div>

      {error ? (
        <p className="px-3 py-6 text-center text-xs text-destructive">
          {error}
        </p>
      ) : oids.length === 0 && done ? (
        <p className="py-6 text-center text-xs text-muted-foreground">
          No commits yet
        </p>
      ) : oids.length === 0 ? (
        <p className="py-6 text-center text-xs text-muted-foreground">
          Loading history…
        </p>
      ) : (
        <div
          ref={parentRef}
          tabIndex={0}
          role="listbox"
          aria-label="Commit history"
          onKeyDown={onKeyDown}
          className={`min-h-0 flex-1 overflow-y-auto outline-none ${SCROLLBAR_CLASS}`}
        >
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: "100%",
              position: "relative",
            }}
          >
            {virtualItems.map((v) => {
              const oid = oids[v.index];
              return (
                <div
                  key={v.key}
                  data-index={v.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${v.start}px)`,
                  }}
                >
                  {oid ? (
                    <CommitRow
                      oid={oid}
                      details={getDetails(oid)}
                      selected={oid === selectedOid}
                      onSelect={onSelectOid}
                      onPrefetch={scheduleHoverPrefetch}
                      onCancelPrefetch={cancelHoverPrefetch}
                    />
                  ) : (
                    <div className="px-3 py-3 text-xs text-muted-foreground">
                      Loading more commits…
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
