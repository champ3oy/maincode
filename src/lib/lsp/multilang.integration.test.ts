import { existsSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { LspClient } from "./client";
import type { Transport } from "./transport";

function framesJS(buf: Buffer): { messages: string[]; rest: Buffer } {
  const out: string[] = [];
  let b = buf;
  for (;;) {
    const sep = b.indexOf("\r\n\r\n");
    if (sep === -1) break;
    const m = /content-length:\s*(\d+)/i.exec(b.subarray(0, sep).toString("utf8"));
    if (!m) { b = b.subarray(sep + 4); continue; }
    const len = Number(m[1]); const start = sep + 4;
    if (b.length < start + len) break;
    out.push(b.subarray(start, start + len).toString("utf8"));
    b = b.subarray(start + len);
  }
  return { messages: out, rest: b };
}
function nodeTransport(cmd: string, args: string[], cwd: string): { transport: Transport; kill: () => void } {
  const child = spawn(cmd, args, { cwd });
  const cbs = new Set<(m: string) => void>();
  let carry = Buffer.alloc(0);
  child.stdout.on("data", (chunk: Buffer) => { carry = Buffer.concat([carry, chunk]); const r = framesJS(carry); carry = r.rest; r.messages.forEach((m) => cbs.forEach((cb) => cb(m))); });
  const transport: Transport = {
    send: async (m) => { child.stdin.write(`Content-Length: ${Buffer.byteLength(m)}\r\n\r\n${m}`); },
    onMessage(cb) { cbs.add(cb); return () => cbs.delete(cb); },
    onExit() { return () => {}; },
    dispose() { child.kill(); },
  };
  return { transport, kill: () => child.kill() };
}

const CACHE = join(homedir(), ".config", "maincode", "servers");
const NODE = `${process.cwd()}/resources/lsp/node`;

type Spec = {
  serverId: string;
  cmd: string;
  args: string[];
  file: string;
  source: string;
  expect: RegExp;
  extra?: (dir: string) => void;
};

const spec: Spec[] = [
  {
    serverId: "python",
    cmd: NODE,
    args: [`${process.cwd()}/resources/lsp/server/node_modules/pyright/langserver.index.js`, "--stdio"],
    file: "a.py",
    source: "x: int = undefined_name\n",
    expect: /undefined_name|is not defined|reportUndefinedVariable/,
  },
  {
    serverId: "rust",
    cmd: join(CACHE, "rust", "rust-analyzer"),
    args: [],
    file: "src/main.rs",
    source: "fn main() { let x: i32 = ; }\n",
    expect: /expected expression|syntax/i,
    extra: (dir: string) => writeFileSync(join(dir, "Cargo.toml"), '[package]\nname="t"\nversion="0.1.0"\nedition="2021"\n'),
  },
  {
    serverId: "go",
    cmd: join(CACHE, "go", "gopls"),
    args: [],
    file: "main.go",
    source: "package main\nfunc main() { var x int = }\n",
    expect: /expected (expression|operand)|syntax/i,
    extra: (dir: string) => writeFileSync(join(dir, "go.mod"), "module t\n\ngo 1.21\n"),
  },
  {
    serverId: "cpp",
    cmd: join(CACHE, "cpp", "clangd_18.1.3", "bin", "clangd"),
    args: [],
    file: "a.cpp",
    source: "int main() { int x = ; }\n",
    expect: /expected (expression|primary-expression)|error/i,
  },
];

for (const s of spec) {
  const present = existsSync(s.cmd);
  describe.skipIf(!present)(`LSP parity: ${s.serverId}`, () => {
    it("returns diagnostics for a broken file", async () => {
      const dir = mkdtempSync(join(tmpdir(), `lsp-${s.serverId}-`));
      s.extra?.(dir);
      const file = join(dir, s.file);
      const fp = join(dir, s.file.includes("/") ? s.file.split("/")[0] : "");
      if (s.file.includes("/")) { const { mkdirSync } = await import("node:fs"); mkdirSync(fp, { recursive: true }); }
      writeFileSync(file, s.source);
      const t = nodeTransport(s.cmd, s.args, dir);
      const c = new LspClient(s.serverId, async () => ({ id: 1, transport: t.transport }));
      await c.openProject(dir);
      c.notifyDocOpened(file, readFileSync(file, "utf8"));
      await new Promise((r) => setTimeout(r, 12000)); // servers take a few s to analyze
      const diags = await c.getDiagnostics(file);
      c.closeProject();
      t.kill();
      expect(diags.map((d) => d.message).join("\n")).toMatch(s.expect);
    }, 40_000);
  });
}
