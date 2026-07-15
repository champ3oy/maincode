import { useState } from "react";
import { IconSparkles } from "@tabler/icons-react";
import { invoke } from "@tauri-apps/api/core";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";

export interface AiCli {
  id: string;
  label: string;
  bin: string;
}

export function AiLauncher({ onLaunch }: { onLaunch: (cli: AiCli) => void }) {
  const [clis, setClis] = useState<AiCli[] | null>(null);

  const load = () =>
    void invoke<AiCli[]>("list_ai_clis")
      .then(setClis)
      .catch(() => setClis([]));

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) load();
      }}
    >
      <DropdownMenuTrigger
        aria-label="AI CLIs"
        title="AI CLIs"
        className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
      >
        <IconSparkles className="size-4" stroke={1.75} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        {clis == null ? (
          <DropdownMenuItem disabled>Loading…</DropdownMenuItem>
        ) : clis.length === 0 ? (
          <DropdownMenuItem disabled>
            No AI CLIs found on your PATH
          </DropdownMenuItem>
        ) : (
          clis.map((c) => (
            <DropdownMenuItem key={c.id} onClick={() => onLaunch(c)}>
              {c.label}
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
