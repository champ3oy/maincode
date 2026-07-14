import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { LspClient } from "./client";
import type { Transport } from "./transport";

const ROOT = "/Users/cirx/Desktop/projects/personal/lugway";
const NODE = `${process.cwd()}/resources/lsp/node`;
const CLI = `${process.cwd()}/resources/lsp/server/node_modules/typescript-language-server/lib/cli.mjs`;
const ok = existsSync(ROOT) && existsSync(CLI);

// Node-side Content-Length frame parser (mirrors the Rust parser used by the
// Tauri path; this test drives the real server directly over a child process,
// so it needs its own framing here rather than pulling `Buffer` into the
// browser-facing protocol.ts module).
function parseFramesJS(buf: Buffer): { messages: string[]; rest: Buffer } {
  const messages: string[] = [];
  let b = buf;
  for (;;) {
    const sep = b.indexOf("\r\n\r\n");
    if (sep === -1) break;
    const header = b.subarray(0, sep).toString("utf8");
    const match = /content-length:\s*(\d+)/i.exec(header);
    if (!match) {
      b = b.subarray(sep + 4);
      continue;
    }
    const len = Number(match[1]);
    const start = sep + 4;
    if (b.length < start + len) break;
    messages.push(b.subarray(start, start + len).toString("utf8"));
    b = b.subarray(start + len);
  }
  return { messages, rest: b };
}

// Node-child transport (bypasses Tauri) so the real server can be driven here.
function nodeTransport(root: string): { id: number; transport: Transport } {
  const child = spawn(NODE, [CLI, "--stdio"], { cwd: root });
  const msgCbs = new Set<(m: string) => void>();
  let carry = Buffer.alloc(0);
  child.stdout.on("data", (chunk: Buffer) => {
    carry = Buffer.concat([carry, chunk]);
    const { messages, rest } = parseFramesJS(carry);
    carry = rest;
    messages.forEach((m) => msgCbs.forEach((cb) => cb(m)));
  });
  const transport: Transport = {
    send: async (m) => {
      child.stdin.write(`Content-Length: ${Buffer.byteLength(m)}\r\n\r\n${m}`);
    },
    onMessage(cb) {
      msgCbs.add(cb);
      return () => msgCbs.delete(cb);
    },
    onExit() {
      return () => {};
    },
    dispose() {
      child.kill();
    },
  };
  return { id: 1, transport };
}

describe.skipIf(!ok)("LSP parity on real lugway monorepo", () => {
  it("resolves @/ alias and go-to-definition in mobile", async () => {
    const c = new LspClient("typescript", async () => nodeTransport(ROOT));
    await c.openProject(ROOT);
    const file = `${ROOT}/mobile/app/wallet/top-up.tsx`;
    const fs = await import("node:fs");
    const src = fs.readFileSync(file, "utf8");
    c.notifyDocOpened(file, src);
    // give tsserver time to build the project + publish diagnostics
    await new Promise((r) => setTimeout(r, 8000));
    const diags = await c.getDiagnostics(file);
    const aliasErrs = diags.filter((d) => /Cannot find module '@\//.test(d.message));
    expect(aliasErrs).toEqual([]);
    const off = src.indexOf("useWallet", src.indexOf('from "@/contexts/wallet"') - 40);
    const def = await c.getDefinition(file, off);
    expect(def?.path).toContain("mobile/contexts/wallet");
    c.closeProject();
  }, 30_000);
});
