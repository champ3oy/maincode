import { describe, expect, it } from "vitest";
import { preloadFilter } from "./client";

describe("preloadFilter", () => {
  it("keeps source and json files only", () => {
    expect(preloadFilter(["a.ts", "b.tsx", "c.css", "d.json", "e.jsx", "f.rs"]))
      .toEqual(["a.ts", "b.tsx", "d.json", "e.jsx"]);
  });
  it("caps at 2000", () => {
    const many = Array.from({ length: 2500 }, (_, i) => `f${i}.ts`);
    expect(preloadFilter(many)).toHaveLength(2000);
  });
});
