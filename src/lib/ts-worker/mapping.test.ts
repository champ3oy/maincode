import { describe, expect, it } from "vitest";
import {
  packageFileCandidates,
  scriptKindForPath,
  mapCompilerOptions,
  mergeConfigPaths,
  tsDiagnosticsToData,
  tsCompletionsToData,
} from "./mapping";

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
  it("maps .mts and .cts to ts (used by tsKindForPath in code-editor)", () => {
    expect(scriptKindForPath("/a/b.mts")).toBe("ts");
    expect(scriptKindForPath("/a/b.cts")).toBe("ts");
  });
  it("maps .json to other so isTsWorkerPath returns false for json files", () => {
    expect(scriptKindForPath("/a/b.json")).toBe("other");
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
    expect(o.libReplacement).toBe(false);
    const bad = mapCompilerOptions("{not json", fakeTs);
    expect(bad.allowJs).toBe(true);
  });
  it("honors strict and checkJs from tsconfig", () => {
    const o = mapCompilerOptions('{"compilerOptions":{"strict":true,"checkJs":true}}', fakeTs);
    expect(o.strict).toBe(true);
    expect(o.checkJs).toBe(true);
  });
  it("forwards path aliases and absolutizes baseUrl against root", () => {
    const o = mapCompilerOptions(
      '{"compilerOptions":{"paths":{"@/*":["./*"]},"baseUrl":"./src"}}',
      fakeTs,
      "/proj",
    );
    expect(o.paths).toEqual({ "@/*": ["./*"] });
    expect(o.baseUrl).toBe("/proj/src"); // "./src" joined onto root
  });
  it("forwards paths with no baseUrl (base falls back to host cwd = root at runtime)", () => {
    const o = mapCompilerOptions('{"compilerOptions":{"paths":{"@/*":["./*"]}}}', fakeTs, "/proj");
    expect(o.paths).toEqual({ "@/*": ["./*"] });
    expect(o.baseUrl).toBeUndefined();
  });
  it("collapses a '.'-style baseUrl to the project root", () => {
    const o = mapCompilerOptions('{"compilerOptions":{"baseUrl":"./"}}', fakeTs, "/proj");
    expect(o.baseUrl).toBe("/proj");
  });
});

describe("mergeConfigPaths", () => {
  const fakeTs = {}; // no parseConfigFileTextToJson → JSON.parse path

  it("rebases each package's @/* to its own absolute dir and unions them", () => {
    const merged = mergeConfigPaths(
      [
        { dir: "/repo/mobile", text: '{"compilerOptions":{"paths":{"@/*":["./*"]}}}' },
        { dir: "/repo/apps/api", text: '{"compilerOptions":{"paths":{"@/*":["./*"]}}}' },
      ],
      fakeTs,
    );
    // Same pattern from two packages → both absolute candidates, wildcard kept.
    expect(merged).toEqual({ "@/*": ["/repo/mobile/*", "/repo/apps/api/*"] });
  });

  it("honors a per-config baseUrl when rebasing substitutions", () => {
    const merged = mergeConfigPaths(
      [{ dir: "/repo/web", text: '{"compilerOptions":{"baseUrl":"src","paths":{"@/*":["*"]}}}' }],
      fakeTs,
    );
    expect(merged).toEqual({ "@/*": ["/repo/web/src/*"] });
  });

  it("returns undefined when no config declares paths", () => {
    expect(
      mergeConfigPaths([{ dir: "/repo/api", text: '{"compilerOptions":{"strict":true}}' }], fakeTs),
    ).toBeUndefined();
  });

  it("skips malformed config text without throwing", () => {
    const merged = mergeConfigPaths(
      [
        { dir: "/a", text: "{not json" },
        { dir: "/b", text: '{"compilerOptions":{"paths":{"~/*":["./lib/*"]}}}' },
      ],
      fakeTs,
    );
    expect(merged).toEqual({ "~/*": ["/b/lib/*"] });
  });
});

describe("tsDiagnosticsToData", () => {
  const fakeTs = {
    DiagnosticCategory: { Error: 1, Warning: 0 },
    flattenDiagnosticMessageText: (m: any) => String(m),
  };

  it("maps diagnostic with start+length to from+to+severity+message", () => {
    const fileText = "0123456789"; // 10 chars
    const diags = [{ start: 2, length: 3, category: 1, messageText: "bad" }];
    const result = tsDiagnosticsToData(diags, fileText, fakeTs);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ from: 2, to: 5, severity: "error", message: "bad" });
  });

  it("clamps to to fileText.length when start+length overruns", () => {
    const fileText = "0123456789"; // 10 chars
    const diags = [{ start: 8, length: 10, category: 1, messageText: "overflow" }];
    const result = tsDiagnosticsToData(diags, fileText, fakeTs);
    expect(result[0].to).toBe(10);
  });

  it("skips entries with start === undefined", () => {
    const fileText = "0123456789";
    const diags = [
      { start: 2, length: 1, category: 1, messageText: "has start" },
      { start: undefined, length: 1, category: 1, messageText: "no start" },
      { length: 1, category: 1, messageText: "also no start" },
    ];
    const result = tsDiagnosticsToData(diags, fileText, fakeTs);
    expect(result).toHaveLength(1);
    expect(result[0].message).toBe("has start");
  });

  it("maps category 0 to severity warning", () => {
    const fileText = "0123456789";
    const diags = [{ start: 0, length: 1, category: 0, messageText: "warn" }];
    const result = tsDiagnosticsToData(diags, fileText, fakeTs);
    expect(result[0].severity).toBe("warning");
  });

  it("caps output at 200 given 250 diagnostics", () => {
    const fileText = "x".repeat(1000);
    const diags = Array.from({ length: 250 }, (_, i) => ({
      start: i,
      length: 1,
      category: 1,
      messageText: `diag ${i}`,
    }));
    const result = tsDiagnosticsToData(diags, fileText, fakeTs);
    expect(result).toHaveLength(200);
  });
});

describe("tsCompletionsToData", () => {
  it("returns [] for null/undefined info", () => {
    expect(tsCompletionsToData(null)).toEqual([]);
    expect(tsCompletionsToData(undefined)).toEqual([]);
  });

  it("returns [] for undefined entries", () => {
    expect(tsCompletionsToData({})).toEqual([]);
    expect(tsCompletionsToData({ entries: undefined })).toEqual([]);
  });

  it("maps entry preserving label/kind/insertText/source/data and shortening source for detail", () => {
    const info = {
      entries: [
        {
          name: "useState",
          kind: "function",
          sortText: "11",
          source: "/proj/node_modules/react/index.d.ts",
          insertText: "useState",
          data: { x: 1 },
        },
      ],
    };
    const result = tsCompletionsToData(info);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe("useState");
    expect(result[0].kind).toBe("function");
    expect(result[0].insertText).toBe("useState");
    expect(result[0].source).toBe("/proj/node_modules/react/index.d.ts");
    expect(result[0].data).toEqual({ x: 1 });
    expect(result[0].detail).toBe("react/index.d.ts");
  });

  it("caps at 300 given 350 entries", () => {
    const info = {
      entries: Array.from({ length: 350 }, (_, i) => ({
        name: `item${i}`,
        kind: "variable",
        sortText: String(i),
        insertText: `item${i}`,
      })),
    };
    const result = tsCompletionsToData(info);
    expect(result).toHaveLength(300);
  });
});
