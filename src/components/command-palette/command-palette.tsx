import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

export interface PaletteCommand {
  id: string;
  label: string;
  run: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Workspace-relative file paths for quick open. */
  files: string[];
  onOpenFile: (relativePath: string) => void;
  commands: PaletteCommand[];
}

export function CommandPalette({
  open,
  onOpenChange,
  files,
  onOpenFile,
  commands,
}: CommandPaletteProps) {
  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Search files and commands…" />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>
        <CommandGroup heading="Commands">
          {commands.map((cmd) => (
            <CommandItem
              key={cmd.id}
              value={`cmd ${cmd.label}`}
              onSelect={() => {
                onOpenChange(false);
                cmd.run();
              }}
            >
              {cmd.label}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="Files">
          {files.map((f) => (
            <CommandItem
              key={f}
              value={f}
              onSelect={() => {
                onOpenChange(false);
                onOpenFile(f);
              }}
            >
              {f}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
