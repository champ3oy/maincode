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

// Brand-colored badge fallback for CLIs whose official mark we don't yet have.
// Keyed by the Rust `id`.
const AI_ICONS: Record<string, { bg: string; glyph: string }> = {
  aider: { bg: "#14b8a6", glyph: "ai" },
  agy: { bg: "#1a73e8", glyph: "▲" },
};

// Per-CLI logo. claude / gemini / opencode use the tools' actual marks
// (recreated as inline SVG); everything else falls back to a colored badge.
function AiCliIcon({ id }: { id: string }) {
  if (id === "claude") {
    // Anthropic Claude — terracotta pixel creature.
    return (
      <svg viewBox="0 0 24 22" className="size-4 shrink-0" aria-hidden fill="#D97757">
        <rect x="5" y="3" width="14" height="9" />
        <rect x="2" y="8" width="3" height="3" />
        <rect x="19" y="8" width="3" height="3" />
        <rect x="6.4" y="12" width="1.8" height="2.6" />
        <rect x="9.2" y="12" width="1.8" height="2.6" />
        <rect x="12.9" y="12" width="1.8" height="2.6" />
        <rect x="15.7" y="12" width="1.8" height="2.6" />
        <rect x="8.6" y="5.8" width="1.9" height="3.3" fill="#fff" />
        <rect x="13.5" y="5.8" width="1.9" height="3.3" fill="#fff" />
      </svg>
    );
  }
  if (id === "gemini") {
    // Google Gemini — four-point sparkle, blue→purple gradient.
    return (
      <svg viewBox="0 0 24 24" className="size-4 shrink-0" aria-hidden>
        <defs>
          <linearGradient id="mc-gemini-grad" x1="0" y1="8" x2="24" y2="16" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#9168C0" />
            <stop offset="0.5" stopColor="#5684D1" />
            <stop offset="1" stopColor="#1BA1E2" />
          </linearGradient>
        </defs>
        <path
          d="M12 1 C 12.5 6.8 17.2 11.5 23 12 C 17.2 12.5 12.5 17.2 12 23 C 11.5 17.2 6.8 12.5 1 12 C 6.8 11.5 12.5 6.8 12 1 Z"
          fill="url(#mc-gemini-grad)"
        />
      </svg>
    );
  }
  if (id === "opencode") {
    // OpenCode — dark tile with a two-tone block.
    return (
      <svg viewBox="0 0 24 24" className="size-4 shrink-0" aria-hidden>
        <rect width="24" height="24" rx="4" fill="#171717" />
        <rect x="8" y="5" width="8" height="5.5" fill="#fff" />
        <rect x="8" y="10.5" width="8" height="8.5" fill="#d1d1d1" />
      </svg>
    );
  }
  if (id === "codex") {
    // OpenAI Codex — blue cloud with a white terminal prompt.
    return (
      <svg viewBox="0 0 24 24" className="size-4 shrink-0" aria-hidden>
        <defs>
          <linearGradient id="mc-codex-grad" x1="4" y1="2" x2="20" y2="22" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#A3A9FF" />
            <stop offset="1" stopColor="#3B4BE8" />
          </linearGradient>
        </defs>
        <g fill="url(#mc-codex-grad)">
          <circle cx="12" cy="12" r="7.6" />
          <circle cx="7" cy="8.5" r="4" />
          <circle cx="17" cy="8.5" r="4" />
          <circle cx="7.5" cy="16.5" r="4" />
          <circle cx="16.5" cy="16.5" r="4" />
          <circle cx="5" cy="12.5" r="3.3" />
          <circle cx="19" cy="12.5" r="3.3" />
        </g>
        <path
          d="M8.4 9.4 L11.4 12 L8.4 14.6"
          fill="none"
          stroke="#fff"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <rect x="12.4" y="13.7" width="4.4" height="1.5" rx="0.75" fill="#fff" />
      </svg>
    );
  }
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
