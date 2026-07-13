import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

// Repo root = three levels up from src/lib/ts-worker/ (this file lives there).
const REPO_ROOT = path.resolve(__dirname, "../../..");

// ---- fake worker "self" (RpcPort) ------------------------------------------
// worker.ts calls createRpc(self, …) at module top, so we must install a fake
// `self` BEFORE dynamic-importing worker.ts. The fake captures everything the
// worker postMessages and lets the test inject messages the same way the main
// thread would (envelope: { id, t: "req"|"res"|"err"|"notify", p }).
type Envelope = { id?: number; t: "req" | "res" | "err" | "notify"; p: unknown };

class FakeSelf {
  private listeners = new Set<(e: MessageEvent) => void>();
  private waiters = new Map<number, (env: Envelope) => void>();
  onNotify: ((payload: unknown) => void) | null = null;

  addEventListener(type: "message", fn: (e: MessageEvent) => void) {
    if (type === "message") this.listeners.add(fn);
  }
  removeEventListener(type: "message", fn: (e: MessageEvent) => void) {
    if (type === "message") this.listeners.delete(fn);
  }

  // worker -> main
  postMessage(msg: unknown) {
    const env = msg as Envelope;
    if (env.t === "notify") this.onNotify?.(env.p);
    else if ((env.t === "res" || env.t === "err") && env.id !== undefined) {
      const w = this.waiters.get(env.id);
      if (w) {
        this.waiters.delete(env.id);
        w(env);
      }
    }
  }

  private deliver(env: Envelope) {
    const e = { data: env } as MessageEvent;
    for (const fn of this.listeners) fn(e);
  }

  private nextId = 1;
  // main -> worker: send a request envelope, resolve with the worker's response.
  request(payload: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiters.set(id, (env) =>
        env.t === "res" ? resolve(env.p) : reject(new Error(String(env.p))),
      );
      this.deliver({ id, t: "req", p: payload });
    });
  }
}

// worker.ts is imported once (module-level createRpc binds to `self`); we keep a
// single fake for the whole run and reset the VFS between tests via openProject.
let fake: FakeSelf;
async function loadWorker() {
  if (fake) return fake;
  fake = new FakeSelf();
  (globalThis as unknown as { self: FakeSelf }).self = fake;
  await import("./worker");
  return fake;
}

type Diag = { from: number; to: number; severity: string; message: string };

/**
 * Drive the worker's on-demand loading loop headlessly: request diagnostics for
 * `file`, serve every needFiles batch from the real filesystem, re-lint after
 * each filesLoaded/typesUpdated, until the traffic settles or MAX_ROUNDS.
 */
async function runLoop(
  root: string,
  file: string,
  source: string,
  tsconfigText: string,
): Promise<{ diags: Diag[]; rounds: number; max: number }> {
  let pendingNeed: string[] | null = null;
  let typesUpdated = false;
  fake.onNotify = (p) => {
    const n = p as { kind: string; paths?: string[] };
    if (n.kind === "needFiles") pendingNeed = n.paths ?? [];
    else if (n.kind === "typesUpdated") typesUpdated = true;
  };

  await fake.request({
    kind: "openProject",
    root,
    files: [{ path: file, content: source }],
    tsconfigText,
  });

  const MAX_ROUNDS = 25;
  let diags: Diag[] = [];
  let rounds = 0;
  for (; rounds < MAX_ROUNDS; rounds++) {
    pendingNeed = null;
    typesUpdated = false;

    diags = (await fake.request({ kind: "diagnostics", path: file })) as Diag[];

    if (pendingNeed && (pendingNeed as string[]).length > 0) {
      const loaded = (pendingNeed as string[]).map((p) => {
        try {
          return { path: p, content: readFileSync(p, "utf8") as string | null };
        } catch {
          return { path: p, content: null as string | null };
        }
      });
      await fake.request({ kind: "filesLoaded", files: loaded });
      continue; // re-lint after loading
    }
    if (typesUpdated) continue; // types changed without a new need; re-lint
    break; // stable: no needFiles, no typesUpdated
  }
  return { diags, rounds, max: MAX_ROUNDS };
}

describe("ts-worker on-demand node_modules resolution (integration)", () => {
  beforeEach(async () => {
    await loadWorker();
  });
  afterEach(() => {
    fake.onNotify = null;
  });

  it(
    "converges on real react: jsx-runtime + react types resolve on demand",
    async () => {
      const file = `${REPO_ROOT}/it-fixture/app.tsx`;
      const source =
        'import { useState } from "react";\n' +
        "export function A(){ const [x] = useState(1); return <div>{x}</div>; }\n";
      const { diags, rounds, max } = await runLoop(
        REPO_ROOT,
        file,
        source,
        JSON.stringify({ compilerOptions: { jsx: "react-jsx" } }),
      );
      const messages = diags.map((d) => d.message).join("\n");
      expect(messages).not.toMatch(/Cannot find module 'react'/);
      expect(messages).not.toMatch(/jsx-runtime/);
      expect(rounds).toBeLessThan(max);
    },
    30_000,
  );

  it(
    "go-to-definition maps a symbol to its 1-based {line, column} across files",
    async () => {
      // Two in-VFS files, no node_modules needed: a local symbol defined in one
      // file and referenced in another. This exercises the full
      // getDefinitionAtPosition → offsetToLineColumn (0-based offset → 1-based
      // line/column) path end to end against a real TS program.
      const root = "/def-fixture";
      const libPath = `${root}/lib.ts`;
      const appPath = `${root}/app.ts`;
      //            1234567890123
      const lib = "export const greeting = 'hi';\n"; // `greeting` starts at col 14, line 1
      const app =
        'import { greeting } from "./lib";\n' + // line 1
        "console.log(greeting);\n"; // line 2: `greeting` at offset "console.log(".length = 12 → col 13
      await fake.request({
        kind: "openProject",
        root,
        files: [
          { path: libPath, content: lib },
          { path: appPath, content: app },
        ],
        tsconfigText: JSON.stringify({ compilerOptions: {} }),
      });

      // Cross-file: from the reference in app.ts to the declaration in lib.ts.
      const refOffset = app.indexOf("greeting", app.indexOf("console.log"));
      const crossFile = (await fake.request({
        kind: "definition",
        path: appPath,
        offset: refOffset,
      })) as { path: string; line: number; column: number } | null;
      expect(crossFile).not.toBeNull();
      expect(crossFile!.path).toBe(libPath);
      expect(crossFile!.line).toBe(1);
      expect(crossFile!.column).toBe(14); // 1-based: `greeting` after "export const "

      // Same-file: definition of the imported binding resolves back into lib.ts too.
      // Null case: whitespace/non-identifier position yields no definition.
      const nullDef = (await fake.request({
        kind: "definition",
        path: appPath,
        offset: 0, // on `import` keyword region with no symbol def
      })) as unknown;
      // getDefinitionAtPosition may return null here; the worker must not throw.
      expect(nullDef === null || typeof nullDef === "object").toBe(true);
    },
    30_000,
  );

  it(
    "converges for an exports-map-typed package (regression: react-router-dom-style)",
    async () => {
      // Self-contained fixture reproducing the real report. A package whose types
      // are reachable ONLY through its package.json "exports"/"types" map (like
      // react-router-dom) — no legacy index.d.ts / @types twin fallback. On the
      // first lint TS reads the manifest to parse the exports map, but it is not
      // in the VFS yet, so resolution fails and is cached. Before the fix, the
      // manifest arriving via filesLoaded never invalidates that cached failure
      // and the loop STALLS forever with "Cannot find module 'pkg-exports'". The
      // fix (clear `missing` + cleanupSemanticCache on content-changing
      // filesLoaded) re-resolves and it converges.
      const root = fixtureRoot;
      const file = `${root}/app.tsx`;
      const source =
        'import { Widget, deep } from "pkg-exports";\n' +
        "export const a = Widget; export const b = deep;\n";
      const { diags, rounds, max } = await runLoop(
        root,
        file,
        source,
        JSON.stringify({ compilerOptions: {} }),
      );
      const messages = diags.map((d) => d.message).join("\n");
      expect(messages).not.toMatch(/Cannot find module 'pkg-exports'/);
      expect(messages).not.toMatch(/Cannot find module 'pkg-dep'/);
      expect(rounds).toBeLessThan(max);
    },
    30_000,
  );
});

// ---- synthetic exports-map fixture (portable; no extra deps) ---------------
let fixtureRoot: string;
{
  fixtureRoot = mkdtempSync(path.join(tmpdir(), "ts-worker-it-"));
  const nm = `${fixtureRoot}/node_modules`;
  const write = (p: string, c: string) => {
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, c);
  };
  // pkg-exports: types only via exports map; re-exports pkg-dep (also exports-only)
  write(
    `${nm}/pkg-exports/package.json`,
    JSON.stringify({
      name: "pkg-exports",
      version: "1.0.0",
      exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
    }),
  );
  write(
    `${nm}/pkg-exports/dist/index.d.ts`,
    'export { deep } from "pkg-dep";\nexport declare const Widget: unknown;\n',
  );
  write(
    `${nm}/pkg-dep/package.json`,
    JSON.stringify({
      name: "pkg-dep",
      version: "1.0.0",
      exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
    }),
  );
  write(`${nm}/pkg-dep/dist/index.d.ts`, "export declare const deep: number;\n");
}
afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});
