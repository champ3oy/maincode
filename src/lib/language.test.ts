import { describe, expect, it } from "vitest";
import { languageKeyForPath } from "./language";

describe("languageKeyForPath", () => {
  it("maps common extensions", () => {
    expect(languageKeyForPath("a.ts")).toBe("typescript");
    expect(languageKeyForPath("a.tsx")).toBe("tsx");
    expect(languageKeyForPath("a.js")).toBe("javascript");
    expect(languageKeyForPath("a.jsx")).toBe("jsx");
    expect(languageKeyForPath("a.py")).toBe("python");
    expect(languageKeyForPath("a.html")).toBe("html");
    expect(languageKeyForPath("a.css")).toBe("css");
    expect(languageKeyForPath("a.json")).toBe("json");
    expect(languageKeyForPath("a.md")).toBe("markdown");
    expect(languageKeyForPath("a.rs")).toBe("rust");
    expect(languageKeyForPath("a.yml")).toBe("yaml");
  });

  it("is case-insensitive and uses the last extension", () => {
    expect(languageKeyForPath("A.TSX")).toBe("tsx");
    expect(languageKeyForPath("archive.tar.json")).toBe("json");
  });

  it("uses only the basename", () => {
    expect(languageKeyForPath("src/deep/dir/mod.rs")).toBe("rust");
  });

  it("returns null for unknown, extension-less, and dotfiles", () => {
    expect(languageKeyForPath("Makefile")).toBeNull();
    expect(languageKeyForPath("file.xyz")).toBeNull();
    expect(languageKeyForPath(".gitignore")).toBeNull();
  });
});
