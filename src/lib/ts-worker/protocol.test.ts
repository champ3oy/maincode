import { describe, expect, it, vi } from "vitest";
import { createRpc } from "./protocol";

function pipePair() {
  // two fake ports wired to each other, delivering asynchronously
  const listeners: [Array<(e: MessageEvent) => void>, Array<(e: MessageEvent) => void>] = [[], []];
  const make = (mine: 0 | 1) => ({
    postMessage(msg: unknown) {
      queueMicrotask(() =>
        listeners[mine === 0 ? 1 : 0].forEach((fn) => fn({ data: msg } as MessageEvent)),
      );
    },
    addEventListener(_: "message", fn: (e: MessageEvent) => void) {
      listeners[mine].push(fn);
    },
  });
  return [make(0), make(1)] as const;
}

describe("createRpc", () => {
  it("resolves a request with the handler's response", async () => {
    const [a, b] = pipePair();
    createRpc(b, async (p) => ({ echoed: p }));
    const rpc = createRpc(a, () => undefined);
    await expect(rpc.request({ x: 1 })).resolves.toEqual({ echoed: { x: 1 } });
  });

  it("matches concurrent responses to the right requests", async () => {
    const [a, b] = pipePair();
    createRpc(b, async (p: any) => p.n * 2);
    const rpc = createRpc(a, () => undefined);
    const [r1, r2] = await Promise.all([rpc.request({ n: 1 }), rpc.request({ n: 21 })]);
    expect([r1, r2]).toEqual([2, 42]);
  });

  it("rejects when the handler throws", async () => {
    const [a, b] = pipePair();
    createRpc(b, () => { throw new Error("boom"); });
    const rpc = createRpc(a, () => undefined);
    await expect(rpc.request({})).rejects.toThrow("boom");
  });

  it("delivers notifications without a response", async () => {
    const [a, b] = pipePair();
    const seen = vi.fn();
    createRpc(b, () => undefined, seen);
    const rpc = createRpc(a, () => undefined);
    rpc.notify({ kind: "typesUpdated" });
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toHaveBeenCalledWith({ kind: "typesUpdated" });
  });
});
