import type { CSSProperties, ReactNode } from "react";
import type {
  ContextMenuItem,
  ContextMenuOpenContext,
} from "@pierre/trees";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { FileOp } from "./file-tree";

interface FileTreeContextMenuProps {
  item: ContextMenuItem;
  context: ContextMenuOpenContext;
  /** Absolute workspace root, used to resolve the item's relative path. */
  rootPath: string;
  onFileOp: (op: FileOp) => void;
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

export function FileTreeContextMenu({
  item,
  context,
  rootPath,
  onFileOp,
}: FileTreeContextMenuProps) {
  const isDir = item.kind === "directory";
  // item.path is relative to the workspace root (trailing slash for dirs).
  const relPath = item.path.replace(/\/$/, "");
  const absPath = `${rootPath.replace(/\/+$/, "")}/${relPath}`;

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(label);
    } catch (e) {
      toast.error(`Copy failed: ${e}`);
    }
  };

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
              "z-50 min-w-52 origin-(--transform-origin) rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none",
            )}
          >
            {isDir && (
              <>
                <Item
                  onClick={() => {
                    context.close();
                    onFileOp({ kind: "new-file", dir: item.path });
                  }}
                >
                  New File…
                </Item>
                <Item
                  onClick={() => {
                    context.close();
                    onFileOp({ kind: "new-folder", dir: item.path });
                  }}
                >
                  New Folder…
                </Item>
                <Separator />
              </>
            )}
            <Item
              onClick={() => {
                context.close();
                revealItemInDir(absPath).catch((e) =>
                  toast.error(`Reveal failed: ${e}`),
                );
              }}
            >
              Reveal in Finder
            </Item>
            <Separator />
            <Item
              onClick={() => {
                context.close();
                void copy(absPath, "Copied path");
              }}
            >
              Copy Path
            </Item>
            <Item
              onClick={() => {
                context.close();
                void copy(relPath, "Copied relative path");
              }}
            >
              Copy Relative Path
            </Item>
            <Separator />
            <Item
              onClick={() => {
                context.close();
                onFileOp({
                  kind: "rename",
                  path: item.path,
                  name: item.name,
                  isDir,
                });
              }}
            >
              Rename…
            </Item>
            <Item
              destructive
              onClick={() => {
                context.close();
                onFileOp({
                  kind: "delete",
                  path: item.path,
                  name: item.name,
                  isDir,
                });
              }}
            >
              Delete
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
  destructive,
}: {
  onClick: () => void;
  children: ReactNode;
  destructive?: boolean;
}) {
  return (
    <MenuPrimitive.Item
      onClick={onClick}
      className={cn(
        "relative flex cursor-default items-center gap-1.5 rounded-md px-1.5 py-1 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground",
        destructive &&
          "text-destructive focus:bg-destructive/10 focus:text-destructive",
      )}
    >
      {children}
    </MenuPrimitive.Item>
  );
}

function Separator() {
  return <MenuPrimitive.Separator className="-mx-1 my-1 h-px bg-border" />;
}
