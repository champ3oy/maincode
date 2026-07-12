import { describe, expect, it } from "vitest";
import {
  initialTabsState,
  isDirty,
  tabsReducer,
  type TabsState,
} from "./editor-tabs-reducer";

const open = (s: TabsState, path: string, content = "x"): TabsState =>
  tabsReducer(s, { type: "open", path, name: path.split("/").pop()!, content });

describe("tabsReducer", () => {
  it("open adds a tab and activates it", () => {
    const s = open(initialTabsState, "/a.ts");
    expect(s.tabs).toHaveLength(1);
    expect(s.activePath).toBe("/a.ts");
    expect(isDirty(s.tabs[0])).toBe(false);
  });

  it("open of an existing path activates without duplicating or clobbering edits", () => {
    let s = open(initialTabsState, "/a.ts", "original");
    s = tabsReducer(s, { type: "edit", path: "/a.ts", content: "edited" });
    s = open(open(s, "/b.ts"), "/a.ts", "reloaded-from-disk");
    expect(s.tabs).toHaveLength(2);
    expect(s.activePath).toBe("/a.ts");
    expect(s.tabs[0].content).toBe("edited");
  });

  it("edit marks dirty; markSaved clears it", () => {
    let s = open(initialTabsState, "/a.ts", "one");
    s = tabsReducer(s, { type: "edit", path: "/a.ts", content: "two" });
    expect(isDirty(s.tabs[0])).toBe(true);
    s = tabsReducer(s, { type: "markSaved", path: "/a.ts" });
    expect(isDirty(s.tabs[0])).toBe(false);
    expect(s.tabs[0].savedContent).toBe("two");
  });

  it("close of the active tab activates its right neighbor, else left, else none", () => {
    let s = open(open(open(initialTabsState, "/a"), "/b"), "/c");
    s = tabsReducer(s, { type: "activate", path: "/b" });
    s = tabsReducer(s, { type: "close", path: "/b" });
    expect(s.activePath).toBe("/c");
    s = tabsReducer(s, { type: "close", path: "/c" });
    expect(s.activePath).toBe("/a");
    s = tabsReducer(s, { type: "close", path: "/a" });
    expect(s.activePath).toBeNull();
    expect(s.tabs).toHaveLength(0);
  });

  it("close of an inactive tab keeps the active tab", () => {
    let s = open(open(initialTabsState, "/a"), "/b");
    s = tabsReducer(s, { type: "close", path: "/a" });
    expect(s.activePath).toBe("/b");
  });

  it("activate of an unknown path is a no-op", () => {
    const s = open(initialTabsState, "/a");
    expect(tabsReducer(s, { type: "activate", path: "/nope" })).toBe(s);
  });

  it("renamePath updates path, name, and activePath", () => {
    let s = open(initialTabsState, "/dir/a.ts");
    s = tabsReducer(s, {
      type: "renamePath",
      from: "/dir/a.ts",
      to: "/dir/b.ts",
      name: "b.ts",
    });
    expect(s.tabs[0].path).toBe("/dir/b.ts");
    expect(s.tabs[0].name).toBe("b.ts");
    expect(s.activePath).toBe("/dir/b.ts");
  });
});
