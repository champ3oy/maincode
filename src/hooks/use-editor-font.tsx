import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";

// Editor font size, adjustable with ⌘= / ⌘- / ⌘0 (wired through the native View
// menu) and persisted across sessions. Mirrors the use-diff-settings pattern.

export const EDITOR_FONT_MIN = 8;
export const EDITOR_FONT_MAX = 24;
export const EDITOR_FONT_DEFAULT = 13;

const STORAGE_KEY = "maincode:editor-font-size";

function clamp(size: number): number {
  return Math.max(EDITOR_FONT_MIN, Math.min(EDITOR_FONT_MAX, Math.round(size)));
}

function readStorage(): number {
  if (typeof window === "undefined") return EDITOR_FONT_DEFAULT;
  try {
    const n = Number(window.localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(n) && n >= EDITOR_FONT_MIN && n <= EDITOR_FONT_MAX
      ? Math.round(n)
      : EDITOR_FONT_DEFAULT;
  } catch {
    return EDITOR_FONT_DEFAULT;
  }
}

function writeStorage(size: number) {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(size));
  } catch {
    // ignore
  }
}

interface EditorFontContextValue {
  fontSize: number;
  increase: () => void;
  decrease: () => void;
  reset: () => void;
}

const EditorFontContext = createContext<EditorFontContextValue | null>(null);

export function EditorFontProvider({ children }: { children: ReactNode }) {
  const [fontSize, setFontSize] = useState<number>(() => readStorage());

  const step = useCallback((delta: number) => {
    setFontSize((prev) => {
      const next = clamp(prev + delta);
      if (next === prev) return prev;
      writeStorage(next);
      return next;
    });
  }, []);

  const increase = useCallback(() => step(1), [step]);
  const decrease = useCallback(() => step(-1), [step]);
  const reset = useCallback(() => {
    setFontSize((prev) => {
      if (prev === EDITOR_FONT_DEFAULT) return prev;
      writeStorage(EDITOR_FONT_DEFAULT);
      return EDITOR_FONT_DEFAULT;
    });
  }, []);

  return (
    <EditorFontContext.Provider value={{ fontSize, increase, decrease, reset }}>
      {children}
    </EditorFontContext.Provider>
  );
}

export function useEditorFont(): EditorFontContextValue {
  const ctx = useContext(EditorFontContext);
  if (!ctx) {
    throw new Error("useEditorFont must be used within EditorFontProvider");
  }
  return ctx;
}
