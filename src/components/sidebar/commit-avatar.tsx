import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

type AvatarStatus = "ok" | "missing";

const avatarCache: Map<string, AvatarStatus> = new Map();

interface CommitAvatarProps {
  email: string;
  name: string;
  size?: number;
  className?: string;
}

function firstInitial(name: string): string {
  for (const ch of name) {
    if (ch.trim().length > 0) return ch.toUpperCase();
  }
  return "?";
}

// Small deterministic hash for the initials-fallback hue. Doesn't need to be
// cryptographic — same email → same color across sessions.
function hashHue(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) - h + input.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % 360;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// Match Zed's approach: skip the special `…[bot]@users.noreply.github.com`
// pseudo-emails — the CDN doesn't have anything for those.
function isBotEmail(email: string): boolean {
  return email.endsWith("[bot]@users.noreply.github.com");
}

function avatarUrl(email: string, sizePx: number): string {
  return `https://avatars.githubusercontent.com/u/e?email=${encodeURIComponent(email)}&s=${sizePx}`;
}

export function CommitAvatar({
  email,
  name,
  size = 24,
  className,
}: CommitAvatarProps) {
  const normalized = normalizeEmail(email);
  const skip = normalized.length === 0 || isBotEmail(normalized);
  const hue = hashHue(normalized || name);
  const bg = `hsl(${hue}, 60%, 40%)`;
  const initial = firstInitial(name);

  const [status, setStatus] = useState<AvatarStatus | "loading">(() => {
    if (skip) return "missing";
    return avatarCache.get(normalized) ?? "loading";
  });

  useEffect(() => {
    if (skip) {
      setStatus("missing");
      return;
    }
    const cached = avatarCache.get(normalized);
    if (cached) {
      setStatus(cached);
      return;
    }
    setStatus("loading");
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      avatarCache.set(normalized, "ok");
      if (!cancelled) setStatus("ok");
    };
    img.onerror = () => {
      avatarCache.set(normalized, "missing");
      if (!cancelled) setStatus("missing");
    };
    img.src = avatarUrl(normalized, size * 2);
    return () => {
      cancelled = true;
      img.onload = null;
      img.onerror = null;
    };
  }, [normalized, skip, size]);

  if (status === "ok") {
    return (
      <img
        src={avatarUrl(normalized, size * 2)}
        width={size}
        height={size}
        alt={name}
        aria-label={name}
        title={name}
        className={cn("shrink-0 rounded-full", className)}
      />
    );
  }

  return (
    <div
      aria-label={name}
      title={name}
      style={{ width: size, height: size, background: bg }}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full text-[10px] font-medium text-white",
        className,
      )}
    >
      {initial}
    </div>
  );
}
