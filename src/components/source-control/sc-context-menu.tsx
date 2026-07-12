import type { CSSProperties } from "react";
import type { ContextMenuItem, ContextMenuOpenContext } from "@pierre/trees";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { cn } from "@/lib/utils";

interface ScContextMenuProps {
  item: ContextMenuItem;
  context: ContextMenuOpenContext;
  isStaged: boolean;
  onStage?: (path: string) => void;
  onUnstage?: (path: string) => void;
  onDiscard?: (path: string) => void;
}

function getFloatingTriggerStyle(
  anchorRect: ContextMenuOpenContext["anchorRect"],
): CSSProperties {
  return {
    border: 0,
    height: 1,
    left: `${anchorRect.left}px`,
    opacity: 0,
    padding: 0,
    pointerEvents: "none",
    position: "fixed",
    top: `${anchorRect.bottom - 1}px`,
    width: 1,
  };
}

function getSideOffset(
  anchorRect: ContextMenuOpenContext["anchorRect"],
): number {
  return anchorRect.width === 0 && anchorRect.height === 0 ? 0 : -2;
}

export function ScContextMenu({
  item,
  context,
  isStaged,
  onStage,
  onUnstage,
  onDiscard,
}: ScContextMenuProps) {
  return (
    <MenuPrimitive.Root
      open
      modal={false}
      onOpenChange={(open) => {
        if (!open) context.close();
      }}
    >
      <MenuPrimitive.Trigger
        render={
          <button
            type="button"
            tabIndex={-1}
            style={getFloatingTriggerStyle(context.anchorRect)}
          />
        }
      />
      <MenuPrimitive.Portal>
        <MenuPrimitive.Positioner
          className="isolate z-50 outline-none"
          align="start"
          side="bottom"
          sideOffset={getSideOffset(context.anchorRect)}
        >
          <MenuPrimitive.Popup
            data-file-tree-context-menu-root="true"
            className={cn(
              "z-50 min-w-40 origin-(--transform-origin) rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none",
            )}
          >
            {isStaged && onUnstage && (
              <MenuItem
                onClick={() => {
                  context.close();
                  onUnstage(item.path);
                }}
              >
                Unstage
              </MenuItem>
            )}
            {!isStaged && onStage && (
              <MenuItem
                onClick={() => {
                  context.close();
                  onStage(item.path);
                }}
              >
                Stage
              </MenuItem>
            )}
            {!isStaged && onDiscard && (
              <MenuItem
                destructive
                onClick={() => {
                  context.close();
                  onDiscard(item.path);
                }}
              >
                Discard Changes
              </MenuItem>
            )}
            <MenuItem
              onClick={() => {
                context.close();
                navigator.clipboard.writeText(item.path).catch(() => {});
              }}
            >
              Copy Path
            </MenuItem>
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}

function MenuItem({
  onClick,
  children,
  destructive,
}: {
  onClick: () => void;
  children: React.ReactNode;
  destructive?: boolean;
}) {
  return (
    <MenuPrimitive.Item
      onClick={onClick}
      className={cn(
        "relative flex cursor-default items-center gap-1.5 rounded-md px-1.5 py-1 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground",
        destructive && "text-destructive focus:bg-destructive/10 focus:text-destructive",
      )}
    >
      {children}
    </MenuPrimitive.Item>
  );
}
