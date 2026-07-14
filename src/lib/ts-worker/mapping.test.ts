import { describe, expect, it } from "vitest";
import { scriptKindForPath } from "./mapping";

describe("scriptKindForPath", () => {
  it("classifies extensions", () => {
    expect(scriptKindForPath("/a/b.tsx")).toBe("tsx");
    expect(scriptKindForPath("/a/b.mjs")).toBe("js");
    expect(scriptKindForPath("/a/b.css")).toBe("other");
  });
  it("maps .mts and .cts to ts", () => {
    expect(scriptKindForPath("/a/b.mts")).toBe("ts");
    expect(scriptKindForPath("/a/b.cts")).toBe("ts");
  });
  it("maps .json to other so isTsWorkerPath returns false for json files", () => {
    expect(scriptKindForPath("/a/b.json")).toBe("other");
  });
});
