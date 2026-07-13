import { describe, expect, it } from "vitest";
import { mergeSettings, DEFAULT_SETTINGS } from "./use-settings";

describe("mergeSettings", () => {
  it("returns all defaults for an empty object", () => {
    const result = mergeSettings({});
    expect(result).toEqual(DEFAULT_SETTINGS);
  });

  it("returns all defaults for null input", () => {
    expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS);
  });

  it("returns all defaults for non-object input", () => {
    expect(mergeSettings("bad")).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings(42)).toEqual(DEFAULT_SETTINGS);
  });

  it("merges a partial editor.fontSize, leaving everything else as default", () => {
    const result = mergeSettings({ editor: { fontSize: 20 } });
    expect(result.editor.fontSize).toBe(20);
    expect(result.editor.fontFamily).toBe(DEFAULT_SETTINGS.editor.fontFamily);
    expect(result.editor.tabSize).toBe(DEFAULT_SETTINGS.editor.tabSize);
    expect(result.editor.wordWrap).toBe(DEFAULT_SETTINGS.editor.wordWrap);
    expect(result.theme).toBe(DEFAULT_SETTINGS.theme);
    expect(result.terminal).toEqual(DEFAULT_SETTINGS.terminal);
    expect(result.diff).toEqual(DEFAULT_SETTINGS.diff);
  });

  it("clamps editor.fontSize to 8–32", () => {
    expect(mergeSettings({ editor: { fontSize: 2 } }).editor.fontSize).toBe(8);
    expect(mergeSettings({ editor: { fontSize: 100 } }).editor.fontSize).toBe(32);
    expect(mergeSettings({ editor: { fontSize: 16 } }).editor.fontSize).toBe(16);
  });

  it("clamps diff.fontSize to 8–32", () => {
    expect(mergeSettings({ diff: { fontSize: 0 } }).diff.fontSize).toBe(8);
    expect(mergeSettings({ diff: { fontSize: 99 } }).diff.fontSize).toBe(32);
  });

  it("clamps terminal.fontSize to 8–24", () => {
    expect(mergeSettings({ terminal: { fontSize: 1 } }).terminal.fontSize).toBe(8);
    expect(mergeSettings({ terminal: { fontSize: 50 } }).terminal.fontSize).toBe(24);
  });

  it("clamps editor.tabSize to 1–8", () => {
    expect(mergeSettings({ editor: { tabSize: 0 } }).editor.tabSize).toBe(1);
    expect(mergeSettings({ editor: { tabSize: 20 } }).editor.tabSize).toBe(8);
    expect(mergeSettings({ editor: { tabSize: 4 } }).editor.tabSize).toBe(4);
  });

  it("falls back to default theme for invalid theme values", () => {
    expect(mergeSettings({ theme: "matrix" }).theme).toBe("system");
    expect(mergeSettings({ theme: 42 }).theme).toBe("system");
  });

  it("accepts valid theme values", () => {
    expect(mergeSettings({ theme: "light" }).theme).toBe("light");
    expect(mergeSettings({ theme: "dark" }).theme).toBe("dark");
    expect(mergeSettings({ theme: "system" }).theme).toBe("system");
  });

  it("falls back to default fontFamily for invalid values", () => {
    expect(mergeSettings({ editor: { fontFamily: "comic-sans" } }).editor.fontFamily).toBe(
      DEFAULT_SETTINGS.editor.fontFamily,
    );
  });

  it("accepts valid fontFamily values", () => {
    expect(mergeSettings({ editor: { fontFamily: "system-mono" } }).editor.fontFamily).toBe(
      "system-mono",
    );
    expect(mergeSettings({ editor: { fontFamily: "courier" } }).editor.fontFamily).toBe(
      "courier",
    );
  });

  it("handles wordWrap for editor and diff", () => {
    const result = mergeSettings({ editor: { wordWrap: true }, diff: { wordWrap: true } });
    expect(result.editor.wordWrap).toBe(true);
    expect(result.diff.wordWrap).toBe(true);
  });

  it("ignores wordWrap of wrong type", () => {
    const result = mergeSettings({ editor: { wordWrap: "yes" } });
    expect(result.editor.wordWrap).toBe(DEFAULT_SETTINGS.editor.wordWrap);
  });

  it("handles completely valid full settings object", () => {
    const full = {
      theme: "dark",
      editor: { fontSize: 14, fontFamily: "courier", tabSize: 4, wordWrap: true },
      terminal: { fontSize: 14 },
      diff: { fontSize: 15, wordWrap: true },
    };
    expect(mergeSettings(full)).toEqual(full);
  });
});
