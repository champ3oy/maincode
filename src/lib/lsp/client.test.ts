import { describe, expect, it, vi } from "vitest";
import { LspClient } from "./client";
import type { Transport } from "./transport";

// A fake transport that records outgoing messages and lets the test push replies.
function makeFake() {
  const sent: any[] = [];
  let onMsg: ((m: string) => void) | null = null;
  const push = (obj: unknown) => onMsg?.(JSON.stringify(obj));
  const transport: Transport = {
    send: async (m) => {
      const msg = JSON.parse(m);
      sent.push(msg);
    },
    onMessage(cb) {
      onMsg = cb;
      return () => {};
    },
    onExit() {
      return () => {};
    },
    dispose() {},
  };
  return { sent, push, transport };
}

function client(fake: ReturnType<typeof makeFake>) {
  return new LspClient("typescript", async () => ({ id: 1, transport: fake.transport }));
}

describe("LspClient", () => {
  it("initializes and reports ready", async () => {
    const fake = makeFake();
    const c = client(fake);
    const opening = c.openProject("/repo");
    await Promise.resolve();
    const init = fake.sent.find((m) => m.method === "initialize");
    fake.push({ jsonrpc: "2.0", id: init.id, result: { capabilities: {} } });
    await opening;
    expect(c.ready()).toBe(true);
    expect(fake.sent[0].method).toBe("initialize");
    expect(fake.sent.find((m) => m.method === "initialized")).toBeTruthy();
  });

  it("buffers didOpen for docs opened before init and replays after initialize", async () => {
    const fake = makeFake();
    // Do NOT auto-reply to initialize yet: open a doc while still initializing.
    const c = new LspClient("typescript", async () => ({ id: 1, transport: fake.transport }));
    const opening = c.openProject("/repo");
    await Promise.resolve();
    c.notifyDocOpened("/repo/a.ts", "const x = 1;\n"); // before ready
    expect(fake.sent.find((m) => m.method === "textDocument/didOpen")).toBeUndefined();
    // now let initialize resolve
    const init = fake.sent.find((m) => m.method === "initialize");
    fake.push({ jsonrpc: "2.0", id: init!.id, result: { capabilities: {} } });
    await opening;
    const didOpen = fake.sent.find((m) => m.method === "textDocument/didOpen");
    expect(didOpen?.params.textDocument.uri).toBe("file:///repo/a.ts");
  });

  it("maps pushed publishDiagnostics to DiagnosticData offsets", async () => {
    const fake = makeFake();
    const c = client(fake);
    const opening = c.openProject("/repo");
    await Promise.resolve();
    const init1 = fake.sent.find((m) => m.method === "initialize");
    fake.push({ jsonrpc: "2.0", id: init1.id, result: { capabilities: {} } });
    await opening;
    c.notifyDocOpened("/repo/a.ts", "const x = 1;\nlet y = 2;\n");
    const fired = vi.fn();
    c.onTypesUpdated(fired);
    fake.push({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri: "file:///repo/a.ts",
        diagnostics: [
          { range: { start: { line: 1, character: 4 }, end: { line: 1, character: 5 } }, severity: 1, message: "bad y" },
        ],
      },
    });
    expect(fired).toHaveBeenCalled();
    // doc: "const x = 1;\nlet y = 2;\n" — line 1 starts at offset 13, so
    // {line:1,character:4}→17 ('y'), {line:1,character:5}→18.
    const diags = await c.getDiagnostics("/repo/a.ts");
    expect(diags).toEqual([{ from: 17, to: 18, severity: "error", message: "bad y" }]);
  });

  it("resolves getDefinition to a 1-based path/line/column", async () => {
    const fake = makeFake();
    const c = client(fake);
    const opening = c.openProject("/repo");
    await Promise.resolve();
    const init = fake.sent.find((m) => m.method === "initialize");
    fake.push({ jsonrpc: "2.0", id: init.id, result: { capabilities: {} } });
    await opening;
    c.notifyDocOpened("/repo/a.ts", "import x from './b';\n");
    const p = c.getDefinition("/repo/a.ts", 7);
    await Promise.resolve();
    const req = fake.sent.find((m) => m.method === "textDocument/definition");
    fake.push({
      jsonrpc: "2.0",
      id: req.id,
      result: [{ uri: "file:///repo/b.ts", range: { start: { line: 4, character: 2 }, end: { line: 4, character: 8 } } }],
    });
    expect(await p).toEqual({ path: "/repo/b.ts", line: 5, column: 3 });
  });

  it("splits hover markdown: leading code fence → signature, rest → documentation", async () => {
    const fake = makeFake();
    const c = client(fake);
    const opening = c.openProject("/repo");
    await Promise.resolve();
    const init = fake.sent.find((m) => m.method === "initialize");
    fake.push({ jsonrpc: "2.0", id: init.id, result: { capabilities: {} } });
    await opening;
    c.notifyDocOpened("/repo/a.ts", "const x = 1;\n");
    const p = c.getHover("/repo/a.ts", 6);
    await Promise.resolve();
    const req = fake.sent.find((m) => m.method === "textDocument/hover");
    fake.push({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        contents: {
          kind: "markdown",
          value: "```typescript\nconst x: number\n```\nA number.\n\n*@example*\n```ts\nx + 1\n```",
        },
      },
    });
    const hover = await p;
    // Leading ```typescript block becomes the (raw, monospace) signature; the
    // rest stays markdown so renderMarkdown formats the prose + @example fence.
    expect(hover?.signature).toEqual([{ text: "const x: number", kind: "code" }]);
    expect(hover?.documentation).toContain("A number.");
    expect(hover?.documentation).toContain("*@example*");
    expect(hover?.documentation).toContain("```ts");
    expect(hover?.documentation).not.toContain("const x: number"); // signature was extracted
  });
});
