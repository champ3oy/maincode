import { existsSync, readFileSync, statSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// REAL-PROJECT integration harness.
//
// Round 1 fixed exports-map resolution with a portable synthetic fixture, and
// react-router-dom now resolves in the real app. But `react/jsx-runtime` STILL
// fails on the user's real "landing" project. This test replicates that project
// EXACTLY inside the headless harness so the failure can be reproduced and the
// fix regression-guarded:
//   - root = the real landing dir; its REAL tsconfig.json text (read via node fs)
//   - preload its real src files the SAME way client.ts does:
//       preloadFilter(listFilesRecursive) then `${root}/${rel}` path join
//   - serve every needFiles batch from node fs, REPLICATING the prod 2 MB read
//     cap (Rust read_file returns content:null / reason "too_large" for files
//     > 2*1024*1024 bytes — @tabler/icons-react's 7.4 MB .d.ts is such a file and
//     is on App.tsx's transitive import graph). readFileSync in round 1's harness
//     had no cap, which is exactly why round 1 missed this.
//   - drive diagnostics for <root>/src/App.tsx through the loop (null on error,
//     up to ~30 rounds).
//
// Skips gracefully (describe.skipIf) when the landing dir is absent so CI / other
// machines stay green. The landing dir is READ-ONLY: this test only reads.
// ---------------------------------------------------------------------------

const LANDING_ROOT = "/Users/cirx/Desktop/projects/personal/maincode/landing";
const landingExists =
  existsSync(LANDING_ROOT) &&
  existsSync(`${LANDING_ROOT}/src/App.tsx`) &&
  existsSync(`${LANDING_ROOT}/node_modules`);

// Prod parity: Rust read_file caps at 2*1024*1024 bytes and returns
// content:null (reason "too_large") above it — becomes `missing` in the worker.
const MAX_FILE_BYTES = 2 * 1024 * 1024;

// Opt-in trace, set TSW_TRACE=1 to print the probe/round diagnostics. Read via
// globalThis to stay type-clean without pulling @types/node into this config
// (matches worker.integration.test.ts, which also runs under vitest, not tsc).
const TRACE = Boolean(
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.TSW_TRACE,
);

/** Read a file the way the prod stack does: >2 MB → null (too_large), miss → null. */
function prodReadFile(p: string): string | null {
  try {
    if (statSync(p).size > MAX_FILE_BYTES) return null; // too_large
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

// ---- preloadFilter (copied EXACTLY from client.ts to mirror prod) -----------
const PRELOAD_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json)$/i;
const PRELOAD_CAP = 2000;
function preloadFilter(paths: string[]): string[] {
  return paths.filter((p) => PRELOAD_EXT.test(p)).slice(0, PRELOAD_CAP);
}

// listFilesRecursive equivalent — mirrors Rust list_files_inner EXACTLY:
//   SKIP_DIRS = [".git","node_modules","target","dist",".next"], default max=5000,
//   returns paths RELATIVE to root, sorted. `${root}/${rel}` then joins the same
//   way client.openProject builds source paths. (Round 1's harness didn't replicate
//   SKIP_DIRS — walking into node_modules/dist is exactly what starved src/App.tsx.)
import { readdirSync } from "node:fs";
const SKIP_DIRS = new Set([".git", "node_modules", "target", "dist", ".next"]);
function listFilesRecursive(root: string, max = 5000): string[] {
  const out: string[] = [];
  const stack = [{ dir: root, rel: "" }];
  while (stack.length) {
    if (out.length >= max) break;
    const { dir, rel } = stack.pop()!;
    let ents: import("node:fs").Dirent[];
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      if (out.length >= max) break;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push({ dir: `${dir}/${e.name}`, rel: childRel });
      } else {
        out.push(childRel);
      }
    }
  }
  out.sort();
  return out;
}

// ---- fake worker "self" (same shape as worker.integration.test.ts) ----------
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

let fake: FakeSelf;
async function loadWorker() {
  if (fake) return fake;
  fake = new FakeSelf();
  (globalThis as unknown as { self: FakeSelf }).self = fake;
  await import("./worker");
  return fake;
}

type Diag = { from: number; to: number; severity: string; message: string };

describe.skipIf(!landingExists)("ts-worker on the REAL landing project (integration)", () => {
  beforeEach(async () => {
    await loadWorker();
  });
  afterEach(() => {
    fake.onNotify = null;
  });

  it(
    "resolves react/jsx-runtime and react-router-dom on <root>/src/App.tsx (no missing-module errors)",
    async () => {
      const root = LANDING_ROOT;
      const appPath = `${root}/src/App.tsx`;

      // Preload real src files exactly like client.openProject does.
      const rel = listFilesRecursive(root);
      const keep = preloadFilter(rel);
      const files: { path: string; content: string }[] = [];
      for (const r of keep) {
        const abs = `${root}/${r}`; // EXACT prod join semantics
        const content = prodReadFile(abs);
        if (content !== null) files.push({ path: abs, content });
      }
      const tsconfigText = prodReadFile(`${root}/tsconfig.json`);
      expect(tsconfigText).not.toBeNull();

      // With prod-faithful listFilesRecursive (SKIP_DIRS excludes node_modules/dist),
      // the src tree is small and App.tsx IS in the preload — matching prod, where the
      // editor also opens the file. If a future project has >5000 src files and App.tsx
      // falls outside the preload window, it would instead enter via docChanged; we
      // handle that case too so the test tracks whichever path prod would take.
      const appSource = prodReadFile(appPath);
      expect(appSource).not.toBeNull();
      const appPreloaded = files.some((f) => f.path === appPath);
      if (TRACE) {
        // eslint-disable-next-line no-console
        console.log(
          `LANDING PRELOAD: totalFiles=${rel.length} kept=${keep.length} ` +
            `appPreloaded=${appPreloaded}`,
        );
      }

      // ---- diagnostics loop, mirroring client.serveFiles + the on-demand loop.
      let pendingNeed: string[] | null = null;
      let typesUpdated = false;
      const jsxRuntimeProbes: string[] = [];
      const tooLargeServed: string[] = [];
      fake.onNotify = (p) => {
        const n = p as { kind: string; paths?: string[] };
        if (n.kind === "needFiles") {
          pendingNeed = n.paths ?? [];
          for (const path of pendingNeed) {
            if (path.includes("jsx-runtime")) jsxRuntimeProbes.push(path);
          }
        } else if (n.kind === "typesUpdated") {
          typesUpdated = true;
        }
      };

      await fake.request({
        kind: "openProject",
        root,
        files,
        tsconfigText,
      });

      // Open App.tsx the way the editor does when the user views it.
      if (!appPreloaded) {
        await fake.request({
          kind: "docChanged",
          path: appPath,
          content: appSource,
          version: Date.now(),
        });
      }

      const MAX_ROUNDS = 30;
      let diags: Diag[] = [];
      let rounds = 0;
      for (; rounds < MAX_ROUNDS; rounds++) {
        pendingNeed = null;
        typesUpdated = false;
        try {
          diags = (await fake.request({ kind: "diagnostics", path: appPath })) as Diag[];
        } catch (err) {
          if (TRACE) {
            // eslint-disable-next-line no-console
            console.log(`  round ${rounds}: WORKER THREW: ${String(err)}`);
          }
          throw err;
        }
        if (TRACE) {
          // eslint-disable-next-line no-console
          console.log(
            `  round ${rounds}: needFiles=${(pendingNeed as string[] | null)?.length ?? 0} ` +
              `diags=${diags.length}`,
          );
        }
        if (pendingNeed && (pendingNeed as string[]).length > 0) {
          const loaded = (pendingNeed as string[]).map((p) => {
            const content = prodReadFile(p);
            if (content === null && existsSync(p) && statSync(p).size > MAX_FILE_BYTES) {
              tooLargeServed.push(p);
            }
            return { path: p, content };
          });
          await fake.request({ kind: "filesLoaded", files: loaded });
          continue;
        }
        if (typesUpdated) continue;
        break;
      }

      const messages = diags.map((d) => `[${d.severity}] ${d.message}`).join("\n");
      if (TRACE) {
        // eslint-disable-next-line no-console
        console.log(
          "LANDING TRACE\n" +
            `rounds=${rounds}/${MAX_ROUNDS}\n` +
            `jsx-runtime probes (${jsxRuntimeProbes.length}):\n  ` +
            jsxRuntimeProbes.join("\n  ") +
            `\ntoo_large (>2MB) served as null (${tooLargeServed.length}):\n  ` +
            tooLargeServed.join("\n  ") +
            `\nDIAGS (${diags.length}):\n${messages}`,
        );
      }
      // Diagnostics for humans if this ever regresses:
      if (/jsx-runtime|Cannot find module 'react-router-dom'/.test(messages)) {
        // eslint-disable-next-line no-console
        console.log(
          "LANDING DIAG FAIL\n" +
            `rounds=${rounds}/${MAX_ROUNDS}\n` +
            `jsx-runtime probes (${jsxRuntimeProbes.length}):\n  ` +
            jsxRuntimeProbes.join("\n  ") +
            `\ntoo_large (>2MB) served as null (${tooLargeServed.length}):\n  ` +
            tooLargeServed.join("\n  ") +
            `\ndiagnostics:\n${messages}`,
        );
      }

      expect(messages).not.toMatch(/react\/jsx-runtime/);
      expect(messages).not.toMatch(/jsx-runtime/);
      expect(messages).not.toMatch(/Cannot find module 'react-router-dom'/);
      expect(rounds).toBeLessThan(MAX_ROUNDS);
    },
    60_000,
  );
});
