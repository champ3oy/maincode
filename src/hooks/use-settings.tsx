import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { readSettings, writeSettings } from "@/lib/settings";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ThemeChoice = "light" | "dark" | "system";
export type FontChoice = "app-mono" | "system-mono" | "courier";

export interface Settings {
  theme: ThemeChoice;
  editor: {
    fontSize: number;
    fontFamily: FontChoice;
    tabSize: number;
    wordWrap: boolean;
    autocomplete: boolean;
    linting: boolean;
    formatOnSave: boolean;
    languageIntelligence: boolean;
  };
  terminal: {
    fontSize: number;
  };
  diff: {
    fontSize: number;
    fontFamily: FontChoice;
    wordWrap: boolean;
  };
}

// ---------------------------------------------------------------------------
// Font stacks
// ---------------------------------------------------------------------------

export const FONT_STACKS: Record<FontChoice, string> = {
  "app-mono": "'App Mono', ui-monospace, monospace",
  "system-mono":
    "ui-monospace, 'SF Mono', Menlo, Monaco, Consolas, 'Liberation Mono', monospace",
  courier: "'Courier New', Courier, monospace",
};

// Recursive partial — lets callers pass any subset of the settings tree.
export type DeepPartial<T> = T extends object
  ? { [K in keyof T]?: DeepPartial<T[K]> }
  : T;

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  editor: { fontSize: 13, fontFamily: "app-mono", tabSize: 2, wordWrap: false, autocomplete: true, linting: true, formatOnSave: false, languageIntelligence: true },
  terminal: { fontSize: 12 },
  diff: { fontSize: 13, fontFamily: "app-mono", wordWrap: false },
};

// ---------------------------------------------------------------------------
// Allowed literal sets (for validation)
// ---------------------------------------------------------------------------

const THEME_CHOICES: ThemeChoice[] = ["light", "dark", "system"];
const FONT_CHOICES: FontChoice[] = ["app-mono", "system-mono", "courier"];

function isThemeChoice(v: unknown): v is ThemeChoice {
  return THEME_CHOICES.includes(v as ThemeChoice);
}

function isFontChoice(v: unknown): v is FontChoice {
  return FONT_CHOICES.includes(v as FontChoice);
}

// ---------------------------------------------------------------------------
// mergeSettings — deep-merge raw JSON over defaults, validate + clamp
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Deep-merge a parsed (but untrusted) JSON value over DEFAULT_SETTINGS.
 * Unknown keys are ignored; wrong types fall back to defaults; numbers are
 * clamped to their valid ranges.
 */
export function mergeSettings(raw: unknown): Settings {
  const d = DEFAULT_SETTINGS;

  if (typeof raw !== "object" || raw === null) return { ...d, editor: { ...d.editor }, terminal: { ...d.terminal }, diff: { ...d.diff } };

  const r = raw as Record<string, unknown>;

  // theme
  const theme: ThemeChoice = isThemeChoice(r.theme) ? r.theme : d.theme;

  // editor
  const re = (typeof r.editor === "object" && r.editor !== null)
    ? (r.editor as Record<string, unknown>)
    : {};
  const editorFontSize = isFiniteNumber(re.fontSize)
    ? clamp(re.fontSize, 8, 32)
    : d.editor.fontSize;
  const fontFamily = isFontChoice(re.fontFamily) ? re.fontFamily : d.editor.fontFamily;
  const tabSize = isFiniteNumber(re.tabSize)
    ? clamp(re.tabSize, 1, 8)
    : d.editor.tabSize;
  const editorWordWrap = typeof re.wordWrap === "boolean" ? re.wordWrap : d.editor.wordWrap;
  const editorAutocomplete = typeof re.autocomplete === "boolean" ? re.autocomplete : d.editor.autocomplete;
  const editorLinting = typeof re.linting === "boolean" ? re.linting : d.editor.linting;
  const editorFormatOnSave = typeof re.formatOnSave === "boolean" ? re.formatOnSave : d.editor.formatOnSave;
  const editorLanguageIntelligence = typeof re.languageIntelligence === "boolean" ? re.languageIntelligence : d.editor.languageIntelligence;

  // terminal
  const rt = (typeof r.terminal === "object" && r.terminal !== null)
    ? (r.terminal as Record<string, unknown>)
    : {};
  const terminalFontSize = isFiniteNumber(rt.fontSize)
    ? clamp(rt.fontSize, 8, 24)
    : d.terminal.fontSize;

  // diff
  const rd = (typeof r.diff === "object" && r.diff !== null)
    ? (r.diff as Record<string, unknown>)
    : {};
  const diffFontSize = isFiniteNumber(rd.fontSize)
    ? clamp(rd.fontSize, 8, 32)
    : d.diff.fontSize;
  const diffFontFamily = isFontChoice(rd.fontFamily) ? rd.fontFamily : d.diff.fontFamily;
  const diffWordWrap = typeof rd.wordWrap === "boolean" ? rd.wordWrap : d.diff.wordWrap;

  return {
    theme,
    editor: { fontSize: editorFontSize, fontFamily, tabSize, wordWrap: editorWordWrap, autocomplete: editorAutocomplete, linting: editorLinting, formatOnSave: editorFormatOnSave, languageIntelligence: editorLanguageIntelligence },
    terminal: { fontSize: terminalFontSize },
    diff: { fontSize: diffFontSize, fontFamily: diffFontFamily, wordWrap: diffWordWrap },
  };
}

// ---------------------------------------------------------------------------
// deepMergePartial — merge a DeepPartial<Settings> into current settings
// (used by patch() so unknown keys can never slip through)
// ---------------------------------------------------------------------------

function deepMergePartial(current: Settings, partial: DeepPartial<Settings>): Settings {
  return mergeSettings({
    theme: partial.theme ?? current.theme,
    editor: {
      fontSize: partial.editor?.fontSize ?? current.editor.fontSize,
      fontFamily: partial.editor?.fontFamily ?? current.editor.fontFamily,
      tabSize: partial.editor?.tabSize ?? current.editor.tabSize,
      wordWrap: partial.editor?.wordWrap ?? current.editor.wordWrap,
      autocomplete: partial.editor?.autocomplete ?? current.editor.autocomplete,
      linting: partial.editor?.linting ?? current.editor.linting,
      formatOnSave: partial.editor?.formatOnSave ?? current.editor.formatOnSave,
      languageIntelligence: partial.editor?.languageIntelligence ?? current.editor.languageIntelligence,
    },
    terminal: {
      fontSize: partial.terminal?.fontSize ?? current.terminal.fontSize,
    },
    diff: {
      fontSize: partial.diff?.fontSize ?? current.diff.fontSize,
      fontFamily: partial.diff?.fontFamily ?? current.diff.fontFamily,
      wordWrap: partial.diff?.wordWrap ?? current.diff.wordWrap,
    },
  });
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface SettingsContextValue {
  settings: Settings;
  patch: (partial: DeepPartial<Settings>) => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);

  // Debounce timer ref — persists across renders without triggering re-renders.
  const writeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced write to disk.
  const schedulePersist = useCallback((next: Settings) => {
    if (writeTimerRef.current !== null) {
      clearTimeout(writeTimerRef.current);
    }
    writeTimerRef.current = setTimeout(() => {
      writeTimerRef.current = null;
      writeSettings(JSON.stringify(next, null, 2)).catch(() => {
        // Ignore write errors — the app remains functional with in-memory state.
      });
    }, 150);
  }, []);

  // Load settings from disk and apply them to state.
  const loadFromDisk = useCallback(() => {
    readSettings()
      .then((raw) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = {};
        }
        setSettings(mergeSettings(parsed));
      })
      .catch(() => {
        // If the command fails, keep current (default) settings.
      });
  }, []);

  // Initial load on mount.
  useEffect(() => {
    loadFromDisk();
  }, [loadFromDisk]);

  // Re-read on window focus so edits to settings.json in the editor apply
  // immediately when the user returns to the window.
  useEffect(() => {
    window.addEventListener("focus", loadFromDisk);
    return () => {
      window.removeEventListener("focus", loadFromDisk);
    };
  }, [loadFromDisk]);

  // Flush any pending write on unmount.
  useEffect(() => {
    return () => {
      if (writeTimerRef.current !== null) {
        clearTimeout(writeTimerRef.current);
      }
    };
  }, []);

  const patch = useCallback(
    (partial: DeepPartial<Settings>) => {
      setSettings((prev) => {
        const next = deepMergePartial(prev, partial);
        schedulePersist(next);
        return next;
      });
    },
    [schedulePersist],
  );

  return (
    <SettingsContext.Provider value={{ settings, patch }}>
      {children}
    </SettingsContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) {
    throw new Error("useSettings must be used within SettingsProvider");
  }
  return ctx;
}
