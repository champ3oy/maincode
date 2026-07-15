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

// Brand-colored badges per CLI (a lightweight stand-in for each tool's mark —
// swap in an official SVG here if you have one). Keyed by the Rust `id`.
const AI_ICONS: Record<string, { bg: string; glyph: string }> = {
  claude: { bg: "#D97757", glyph: "✳" },
  opencode: { bg: "#475569", glyph: ">_" },
  gemini: { bg: "#4285F4", glyph: "✦" },
  aider: { bg: "#14b8a6", glyph: "ai" },
  codex: { bg: "#0a0a0a", glyph: "{}" },
  agy: { bg: "#1a73e8", glyph: "▲" },
};

function AiCliIcon({ id }: { id: string }) {
  const ic = AI_ICONS[id];
  return (
    <span
      aria-hidden
      className="flex size-4 shrink-0 items-center justify-center rounded text-[9px] font-semibold leading-none text-white"
      style={{ backgroundColor: ic?.bg ?? "var(--muted)" }}
    >
      {ic?.glyph ?? "?"}
    </span>
  );
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
      <DropdownMenuContent align="end" className="w-44">
        {clis == null ? (
          <DropdownMenuItem disabled>Loading…</DropdownMenuItem>
        ) : clis.length === 0 ? (
          <DropdownMenuItem disabled>
            No AI CLIs found on your PATH
          </DropdownMenuItem>
        ) : (
          clis.map((c) => (
            <DropdownMenuItem
              key={c.id}
              onClick={() => onLaunch(c)}
              className="gap-2"
            >
              <AiCliIcon id={c.id} />
              {c.label}
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
