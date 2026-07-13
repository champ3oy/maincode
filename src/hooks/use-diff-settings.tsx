import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";

export type FontChoice = "app-mono" | "system-mono" | "courier";

export interface DiffSettings {
  font: FontChoice;
  fontSize: number;
  wrap: boolean;
}

export const FONT_LABELS: Record<FontChoice, string> = {
  "app-mono": "App Mono",
  "system-mono": "System Mono",
  courier: "Courier",
};

export const FONT_STACKS: Record<FontChoice, string> = {
  "app-mono": "'App Mono', ui-monospace, monospace",
  "system-mono":
    "ui-monospace, 'SF Mono', Menlo, Monaco, Consolas, 'Liberation Mono', monospace",
  courier: "'Courier New', Courier, monospace",
};

export const FONT_SIZE_MIN = 11;
export const FONT_SIZE_MAX = 22;
export const DEFAULT_DIFF_SETTINGS: DiffSettings = {
  font: "app-mono",
  fontSize: 13,
  wrap: false,
};

const STORAGE_KEY = "maincode:diff-settings";

function isFontChoice(value: unknown): value is FontChoice {
  return value === "app-mono" || value === "system-mono" || value === "courier";
}

function readStorage(): DiffSettings {
  if (typeof window === "undefined") return DEFAULT_DIFF_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_DIFF_SETTINGS;
    const parsed = JSON.parse(raw);
    const font: FontChoice = isFontChoice(parsed?.font)
      ? parsed.font
      : DEFAULT_DIFF_SETTINGS.font;
    const rawSize = Number(parsed?.fontSize);
    const fontSize =
      Number.isFinite(rawSize) &&
      rawSize >= FONT_SIZE_MIN &&
      rawSize <= FONT_SIZE_MAX
        ? Math.round(rawSize)
        : DEFAULT_DIFF_SETTINGS.fontSize;
    const wrap =
      typeof parsed?.wrap === "boolean"
        ? parsed.wrap
        : DEFAULT_DIFF_SETTINGS.wrap;
    return { font, fontSize, wrap };
  } catch {
    return DEFAULT_DIFF_SETTINGS;
  }
}

function writeStorage(settings: DiffSettings) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // ignore
  }
}

export function resolveFontFamily(font: FontChoice): string {
  return FONT_STACKS[font];
}

export function resolveLineHeight(fontSize: number): number {
  return Math.round(fontSize * 1.46);
}

interface DiffSettingsContextValue {
  settings: DiffSettings;
  setFont: (font: FontChoice) => void;
  setFontSize: (size: number) => void;
  setWrap: (wrap: boolean) => void;
}

const DiffSettingsContext = createContext<DiffSettingsContextValue | null>(
  null,
);

export function DiffSettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<DiffSettings>(() => readStorage());

  const setFont = useCallback((font: FontChoice) => {
    setSettings((prev) => {
      if (prev.font === font) return prev;
      const next = { ...prev, font };
      writeStorage(next);
      return next;
    });
  }, []);

  const setFontSize = useCallback((size: number) => {
    const clamped = Math.max(
      FONT_SIZE_MIN,
      Math.min(FONT_SIZE_MAX, Math.round(size)),
    );
    setSettings((prev) => {
      if (prev.fontSize === clamped) return prev;
      const next = { ...prev, fontSize: clamped };
      writeStorage(next);
      return next;
    });
  }, []);

  const setWrap = useCallback((wrap: boolean) => {
    setSettings((prev) => {
      if (prev.wrap === wrap) return prev;
      const next = { ...prev, wrap };
      writeStorage(next);
      return next;
    });
  }, []);

  return (
    <DiffSettingsContext.Provider
      value={{ settings, setFont, setFontSize, setWrap }}
    >
      {children}
    </DiffSettingsContext.Provider>
  );
}

export function useDiffSettings(): DiffSettingsContextValue {
  const ctx = useContext(DiffSettingsContext);
  if (!ctx) {
    throw new Error("useDiffSettings must be used within DiffSettingsProvider");
  }
  return ctx;
}
