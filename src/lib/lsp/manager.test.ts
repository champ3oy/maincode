import { describe, expect, it, vi } from "vitest";
import { makeManager } from "./manager";

describe("client manager", () => {
  it("routes by language and lazily creates one client per server", () => {
    const created: string[] = [];
    const fakeClient = () => ({ openProject: vi.fn().mockResolvedValue(undefined), closeProject: vi.fn() }) as any;
    const mgr = makeManager((serverId) => { created.push(serverId); return fakeClient(); });
    mgr.setProjectRoot("/repo");
    expect(mgr.hasLspServer("/repo/a.ts")).toBe(true);
    expect(mgr.hasLspServer("/repo/x.toml")).toBe(false);
    const a = mgr.clientForPath("/repo/a.ts");
    const b = mgr.clientForPath("/repo/b.tsx"); // same server → same client
    expect(a).toBe(b);
    const py = mgr.clientForPath("/repo/s.py"); // different server → new client
    expect(py).not.toBe(a);
    expect(created).toEqual(["typescript", "python"]);
    expect(mgr.clientForPath("/repo/x.toml")).toBeNull();
  });

  it("closes clients on root change", () => {
    const closes: any[] = [];
    const mgr = makeManager(() => ({ openProject: vi.fn().mockResolvedValue(undefined), closeProject: () => closes.push(1) }) as any);
    mgr.setProjectRoot("/a");
    mgr.clientForPath("/a/f.ts");
    mgr.setProjectRoot("/b");
    expect(closes.length).toBe(1);
  });
});
