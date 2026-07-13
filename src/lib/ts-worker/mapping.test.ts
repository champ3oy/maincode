import { describe, expect, it } from "vitest";
import { packageFileCandidates, scriptKindForPath, mapCompilerOptions } from "./mapping";

describe("packageFileCandidates", () => {
  it("probes the package and its @types twin", () => {
    const c = packageFileCandidates("react", "/proj");
    expect(c).toContain("/proj/node_modules/react/package.json");
    expect(c).toContain("/proj/node_modules/@types/react/package.json");
    expect(c).toContain("/proj/node_modules/@types/react/index.d.ts");
  });
  it("handles scoped packages (@scope/pkg → @types/scope__pkg)", () => {
    const c = packageFileCandidates("@tauri-apps/api", "/proj");
    expect(c).toContain("/proj/node_modules/@tauri-apps/api/package.json");
    expect(c).toContain("/proj/node_modules/@types/tauri-apps__api/package.json");
  });
  it("ignores relative imports", () => {
    expect(packageFileCandidates("./local", "/proj")).toEqual([]);
  });
});

describe("scriptKindForPath", () => {
  it("classifies extensions", () => {
    expect(scriptKindForPath("/a/b.tsx")).toBe("tsx");
    expect(scriptKindForPath("/a/b.mjs")).toBe("js");
    expect(scriptKindForPath("/a/b.css")).toBe("other");
  });
});

describe("mapCompilerOptions", () => {
  const fakeTs = { // only what the mapper touches
    JsxEmit: { ReactJSX: 4 }, ScriptTarget: { ESNext: 99 },
    ModuleKind: { ESNext: 99 }, ModuleResolutionKind: { Bundler: 100 },
  };
  it("returns defaults for null/malformed tsconfig", () => {
    const o = mapCompilerOptions(null, fakeTs);
    expect(o.allowJs).toBe(true);
    expect(o.skipLibCheck).toBe(true);
    const bad = mapCompilerOptions("{not json", fakeTs);
    expect(bad.allowJs).toBe(true);
  });
  it("honors strict and checkJs from tsconfig", () => {
    const o = mapCompilerOptions('{"compilerOptions":{"strict":true,"checkJs":true}}', fakeTs);
    expect(o.strict).toBe(true);
    expect(o.checkJs).toBe(true);
  });
});
