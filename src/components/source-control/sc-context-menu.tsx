import type { ContextMenuItem, ContextMenuOpenContext } from "@pierre/trees";

interface ScContextMenuProps {
  item: ContextMenuItem;
  context: ContextMenuOpenContext;
  isStaged: boolean;
  onStage?: (path: string) => void;
  onUnstage?: (path: string) => void;
  onDiscard?: (path: string) => void;
}

export function ScContextMenu({
  item,
  context,
  isStaged,
  onStage,
  onUnstage,
  onDiscard,
}: ScContextMenuProps) {
  const { anchorRect } = context;

  const style: React.CSSProperties = {
    position: "fixed",
    top: anchorRect.bottom,
    left: anchorRect.left,
    zIndex: 50,
    minWidth: 140,
    background: "var(--popover)",
    border: "1px solid var(--border)",
    borderRadius: "6px",
    padding: "4px",
    boxShadow: "0 4px 16px rgba(0,0,0,0.2)",
    color: "var(--popover-foreground)",
    fontSize: "12px",
  };

  const itemStyle: React.CSSProperties = {
    padding: "5px 8px",
    borderRadius: "4px",
    cursor: "pointer",
    display: "block",
    width: "100%",
    textAlign: "left",
    background: "transparent",
    border: "none",
    color: "inherit",
  };

  return (
    <div style={style} data-file-tree-context-menu-root="true">
      {isStaged && onUnstage && (
        <button
          type="button"
          style={itemStyle}
          onClick={() => { context.close(); onUnstage(item.path); }}
          onMouseEnter={(e) => { (e.target as HTMLElement).style.background = "var(--accent)"; }}
          onMouseLeave={(e) => { (e.target as HTMLElement).style.background = "transparent"; }}
        >
          Unstage
        </button>
      )}
      {!isStaged && onStage && (
        <button
          type="button"
          style={itemStyle}
          onClick={() => { context.close(); onStage(item.path); }}
          onMouseEnter={(e) => { (e.target as HTMLElement).style.background = "var(--accent)"; }}
          onMouseLeave={(e) => { (e.target as HTMLElement).style.background = "transparent"; }}
        >
          Stage
        </button>
      )}
      {!isStaged && onDiscard && (
        <button
          type="button"
          style={itemStyle}
          onClick={() => { context.close(); onDiscard(item.path); }}
          onMouseEnter={(e) => { (e.target as HTMLElement).style.background = "var(--accent)"; }}
          onMouseLeave={(e) => { (e.target as HTMLElement).style.background = "transparent"; }}
        >
          Discard Changes
        </button>
      )}
      <button
        type="button"
        style={itemStyle}
        onClick={() => {
          context.close();
          navigator.clipboard.writeText(item.path).catch(() => {});
        }}
        onMouseEnter={(e) => { (e.target as HTMLElement).style.background = "var(--accent)"; }}
        onMouseLeave={(e) => { (e.target as HTMLElement).style.background = "transparent"; }}
      >
        Copy Path
      </button>
    </div>
  );
}
