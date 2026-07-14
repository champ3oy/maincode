import { describe, expect, it, vi } from "vitest";
import { makeManager, serverIdForPath } from "./manager";

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

  it("routes the node-server languages to their server ids", () => {
    expect(serverIdForPath("a.vue")).toBe("vue");
    expect(serverIdForPath("a.svelte")).toBe("svelte");
    expect(serverIdForPath("schema.graphql")).toBe("graphql");
    expect(serverIdForPath("q.gql")).toBe("graphql");
    expect(serverIdForPath("deploy.yml")).toBe("yaml");
    expect(serverIdForPath("config.json")).toBe("json");
    expect(serverIdForPath("index.html")).toBe("html");
    expect(serverIdForPath("styles.css")).toBe("css");
    expect(serverIdForPath("Dockerfile")).toBe("dockerfile");
    expect(serverIdForPath("run.sh")).toBe("bash");
  });
});
