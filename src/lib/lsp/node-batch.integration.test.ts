import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { LspClient } from "./client";
import type { Transport } from "./transport";

// This is a hermetic integration probe: it spawns each bundled node LSP server
// directly as a child process (bypassing Tauri) and asserts it initializes and
// answers. Under vitest there's no Tauri runtime, so `LspClient.openProject`'s
// `invoke("lsp_init_options", …)` call is mocked here. Only the vue server needs
// real initializationOptions (tsdk) to fully initialize; all other servers get
// `null`, matching what the real backend would return for them today.
const NODE = `${process.cwd()}/resources/lsp/node`;
const TSDK = `${process.cwd()}/resources/lsp/server/node_modules/typescript/lib`;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((_cmd: string, arg?: { serverId?: string }) =>
    Promise.resolve(arg?.serverId === "vue" ? { typescript: { tsdk: TSDK } } : null),
  ),
}));

function framesJS(buf: Buffer): { messages: string[]; rest: Buffer } {
  const out: string[] = [];
  let b = buf;
  for (;;) {
    const sep = b.indexOf("\r\n\r\n");
    if (sep === -1) break;
    const m = /content-length:\s*(\d+)/i.exec(b.subarray(0, sep).toString("utf8"));
    if (!m) {
      b = b.subarray(sep + 4);
      continue;
    }
    const len = Number(m[1]);
    const start = sep + 4;
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
  child.stdout.on("data", (chunk: Buffer) => {
    carry = Buffer.concat([carry, chunk]);
    const r = framesJS(carry);
    carry = r.rest;
    r.messages.forEach((m) => cbs.forEach((cb) => cb(m)));
  });
  const transport: Transport = {
    send: async (m) => {
      child.stdin.write(`Content-Length: ${Buffer.byteLength(m)}\r\n\r\n${m}`);
    },
    onMessage(cb) {
      cbs.add(cb);
      return () => cbs.delete(cb);
    },
    onExit() {
      return () => {};
    },
    dispose() {
      child.kill();
    },
  };
  return { transport, kill: () => child.kill() };
}

type Spec = {
  serverId: string;
  entry: string;
  args: string[];
  file: string;
  source: string;
};

const ROOT = `${process.cwd()}/resources/lsp/server/node_modules`;

const SPEC: Spec[] = [
  {
    serverId: "bash",
    entry: `${ROOT}/bash-language-server/out/cli.js`,
    args: ["start"],
    file: "a.sh",
    source: "#!/usr/bin/env bash\necho hi\n",
  },
  {
    serverId: "yaml",
    entry: `${ROOT}/yaml-language-server/bin/yaml-language-server`,
    args: ["--stdio"],
    file: "a.yaml",
    source: "foo: bar\n",
  },
  {
    serverId: "json",
    entry: `${ROOT}/vscode-langservers-extracted/bin/vscode-json-language-server`,
    args: ["--stdio"],
    file: "a.json",
    source: '{"a": 1}\n',
  },
  {
    serverId: "html",
    entry: `${ROOT}/vscode-langservers-extracted/bin/vscode-html-language-server`,
    args: ["--stdio"],
    file: "a.html",
    source: "<h1>hi</h1>\n",
  },
  {
    serverId: "css",
    entry: `${ROOT}/vscode-langservers-extracted/bin/vscode-css-language-server`,
    args: ["--stdio"],
    file: "a.css",
    source: "a { color: red; }\n",
  },
  {
    serverId: "dockerfile",
    entry: `${ROOT}/dockerfile-language-server-nodejs/bin/docker-langserver`,
    args: ["--stdio"],
    file: "Dockerfile",
    source: "FROM alpine\n",
  },
  {
    serverId: "svelte",
    entry: `${ROOT}/svelte-language-server/bin/server.js`,
    args: ["--stdio"],
    file: "a.svelte",
    source: "<script>let x = 1;</script>\n",
  },
  {
    serverId: "graphql",
    entry: `${ROOT}/graphql-language-service-cli/bin/graphql.js`,
    args: ["server", "-m", "stream"],
    file: "a.graphql",
    source: "type Query { hi: String }\n",
  },
  {
    serverId: "vue",
    entry: `${ROOT}/@vue/language-server/bin/vue-language-server.js`,
    args: ["--stdio"],
    file: "a.vue",
    source: "<template><div>hi</div></template>\n",
  },
];

for (const s of SPEC) {
  describe.skipIf(!existsSync(s.entry))(`node LSP: ${s.serverId}`, () => {
    it(
      "spawns, initializes, and answers a query without throwing",
      async () => {
        const dir = mkdtempSync(join(tmpdir(), `lsp-node-${s.serverId}-`));
        const file = join(dir, s.file);
        writeFileSync(file, s.source);

        const t = nodeTransport(NODE, [s.entry, ...s.args], dir);
        const c = new LspClient(s.serverId, async () => ({ id: 1, transport: t.transport }));

        try {
          await c.openProject(dir);
          c.notifyDocOpened(file, s.source);
          // Servers take a few seconds to fully initialize (esp. vue, which
          // loads the TS plugin).
          await new Promise((r) => setTimeout(r, 5000));

          expect(c.ready()).toBe(true);
          await expect(c.getDiagnostics(file)).resolves.toBeDefined();
        } finally {
          c.closeProject();
          t.kill();
        }
      },
      30_000,
    );
  });
}
