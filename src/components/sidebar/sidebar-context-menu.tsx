import type { CSSProperties } from "react";
import type { ContextMenuItem, ContextMenuOpenContext } from "@pierre/trees";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { cn } from "@/lib/utils";

interface SidebarContextMenuProps {
  item: ContextMenuItem;
  context: ContextMenuOpenContext;
  isStaged: boolean;
  onStage?: (path: string) => void;
  onUnstage?: (path: string) => void;
  onDiscard?: (path: string) => void;
  onCopyPath: (path: string) => void;
  onRevealInFinder: (path: string) => void;
}

// Positions the hidden Base UI menu trigger so its bottom-left corner sits on
// the file-tree anchor point. The Positioner then aligns the menu's top-left
// corner to that trigger. Matches Pierre's reference TreeApp implementation.
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

export function SidebarContextMenu({
  item,
  context,
  isStaged,
  onStage,
  onUnstage,
  onDiscard,
  onCopyPath,
  onRevealInFinder,
}: SidebarContextMenuProps) {
  const showStage = !isStaged && onStage;
  const showUnstage = isStaged && onUnstage;
  const showDiscard = !!onDiscard;
  const showSeparator = showStage || showUnstage || showDiscard;

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
            aria-hidden="true"
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
            {showStage && (
              <Item onClick={() => onStage!(item.path)}>Stage</Item>
            )}
            {showUnstage && (
              <Item onClick={() => onUnstage!(item.path)}>Unstage</Item>
            )}
            {showDiscard && (
              <Item onClick={() => onDiscard!(item.path)}>Discard changes</Item>
            )}
            {showSeparator && <Separator />}
            <Item onClick={() => onCopyPath(item.path)}>Copy path</Item>
            <Item onClick={() => onRevealInFinder(item.path)}>
              Reveal in Finder
            </Item>
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}

function Item({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <MenuPrimitive.Item
      onClick={onClick}
      className="relative flex cursor-default items-center gap-1.5 rounded-md px-1.5 py-1 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground"
    >
      {children}
    </MenuPrimitive.Item>
  );
}

function Separator() {
  return <MenuPrimitive.Separator className="-mx-1 my-1 h-px bg-border" />;
}
