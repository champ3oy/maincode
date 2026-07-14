import { describe, expect, it } from "vitest";
import { offsetToPosition, positionToOffset, pathToUri, uriToPath } from "./protocol";

const doc = "abc\ndef\nghij"; // line0 len3, line1 len3, line2 len4

describe("offsetToPosition", () => {
  it("maps offsets to 0-based line/character", () => {
    expect(offsetToPosition(doc, 0)).toEqual({ line: 0, character: 0 });
    expect(offsetToPosition(doc, 5)).toEqual({ line: 1, character: 1 }); // 'e'
    expect(offsetToPosition(doc, 8)).toEqual({ line: 2, character: 0 }); // 'g'
  });
});

describe("positionToOffset", () => {
  it("is the inverse of offsetToPosition", () => {
    for (const off of [0, 3, 4, 5, 8, 12]) {
      expect(positionToOffset(doc, offsetToPosition(doc, off))).toBe(off);
    }
  });
  it("clamps a character past line end to the line end", () => {
    expect(positionToOffset(doc, { line: 0, character: 99 })).toBe(3);
  });
});

describe("uri <-> path", () => {
  it("round-trips absolute paths with spaces", () => {
    const p = "/Users/a b/c/main.ts";
    expect(uriToPath(pathToUri(p))).toBe(p);
    expect(pathToUri(p)).toMatch(/^file:\/\//);
  });
});
