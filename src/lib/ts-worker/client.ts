import { readFile, listFilesRecursive } from "@/lib/fs";
import {
  createRpc,
  type CompletionItemData,
  type CompletionsResult,
  type DefinitionResult,
  type DetailsResult,
  type DiagnosticData,
  type FileEntry,
  type HoverResult,
  type WorkerNotification,
} from "./protocol";
import { scriptKindForPath } from "./mapping";

const PRELOAD_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json)$/i;
const PRELOAD_CAP = 2000;
// tsconfig.json, jsconfig.json, and variants like tsconfig.base.json — anchored
// to a path segment start so we don't match e.g. `my.tsconfig.json`.
const CONFIG_RE = /(^|\/)(tsconfig|jsconfig)(\..+)?\.json$/i;
const CONFIG_CAP = 50;

export function preloadFilter(paths: string[]): string[] {
  return paths.filter((p) => PRELOAD_EXT.test(p)).slice(0, PRELOAD_CAP);
}

export function isTsWorkerPath(path: string): boolean {
  return scriptKindForPath(path) !== "other";
}

export interface TsClient {
  openProject(root: string): Promise<void>;
  closeProject(): void;
  ready(): boolean;
  notifyDocChanged(path: string, content: string): void;
  getCompletions(path: string, offset: number): Promise<CompletionsResult | null>;
  getCompletionDetails(path: string, offset: number, item: CompletionItemData): Promise<DetailsResult | null>;
  getDiagnostics(path: string): Promise<DiagnosticData[]>;
  getHover(path: string, offset: number): Promise<HoverResult | null>;
  getDefinition(path: string, offset: number): Promise<DefinitionResult | null>;
  onTypesUpdated(fn: () => void): () => void;
}

class Client implements TsClient {
  private worker: Worker | null = null;
  private rpc: ReturnType<typeof createRpc> | null = null;
  private root: string | null = null;
  private isReady = false;
  private typesListeners = new Set<() => void>();
  private docTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private openSeq = 0;

  private ensureWorker() {
    if (this.worker) return;
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    const w = this.worker;
    w.addEventListener("error", () => { if (this.worker === w) this.closeProject(); }); // degrade silently; guard: only close if still current worker
    this.rpc = createRpc(
      this.worker as unknown as import("./protocol").RpcPort,
      () => undefined,
      (n) => {
        const note = n as WorkerNotification;
        if (note.kind === "needFiles") void this.serveFiles(note.paths);
        else if (note.kind === "typesUpdated") this.typesListeners.forEach((fn) => fn());
      },
    );
  }

  private async serveFiles(paths: string[]) {
    const filesLoaded: FileEntry[] = await Promise.all(
      paths.map(async (path) => {
        try {
          const r = await readFile(path);
          return { path, content: r.content };
        } catch {
          return { path, content: null };
        }
      }),
    );
    await this.rpc?.request({ kind: "filesLoaded", files: filesLoaded });
  }

  async openProject(root: string): Promise<void> {
    if (this.root === root && this.isReady) return;
    this.closeProject();
    this.root = root;
    this.ensureWorker();
    const seq = ++this.openSeq;
    const rel = await listFilesRecursive(root).catch(() => [] as string[]);
    if (seq !== this.openSeq) return;
    const keep = preloadFilter(rel);
    const sources = await Promise.all(
      keep.map(async (r) => {
        const abs = `${root}/${r}`;
        try {
          const res = await readFile(abs);
          return res.content !== null ? { path: abs, content: res.content } : null;
        } catch {
          return null;
        }
      }),
    );
    if (seq !== this.openSeq) return;
    const tsconfigText =
      (await readFile(`${root}/tsconfig.json`).then((r) => r.content).catch(() => null)) ??
      (await readFile(`${root}/jsconfig.json`).then((r) => r.content).catch(() => null));
    if (seq !== this.openSeq) return;
    // Discover every ts/jsconfig in the workspace (monorepos keep one per
    // package, often with a `@/*` alias, and may have none at the root). Their
    // dirs let the worker rebase each package's `paths` correctly. `rel` came
    // from listFilesRecursive, which already skips node_modules/dist/etc.
    const configRels = rel.filter((r) => CONFIG_RE.test(r)).slice(0, CONFIG_CAP);
    const tsconfigs = (
      await Promise.all(
        configRels.map(async (r) => {
          const abs = `${root}/${r}`;
          const text = await readFile(abs).then((x) => x.content).catch(() => null);
          if (text === null) return null;
          return { dir: abs.slice(0, abs.lastIndexOf("/")), text };
        }),
      )
    ).filter((c): c is { dir: string; text: string } => c !== null);
    if (seq !== this.openSeq) return;
    await this.rpc!.request({
      kind: "openProject",
      root,
      files: sources.filter((s): s is { path: string; content: string } => s !== null),
      tsconfigText,
      tsconfigs,
    });
    if (seq !== this.openSeq) return;
    this.isReady = true;
  }

  closeProject(): void {
    this.openSeq++; // invalidate any in-flight openProject continuations
    this.worker?.terminate();
    this.worker = null;
    this.rpc = null;
    this.root = null;
    this.isReady = false;
    this.docTimers.forEach((t) => clearTimeout(t));
    this.docTimers.clear();
  }

  ready(): boolean {
    return this.isReady;
  }

  notifyDocChanged(path: string, content: string): void {
    if (!this.isReady) return;
    const prev = this.docTimers.get(path);
    if (prev) clearTimeout(prev);
    this.docTimers.set(
      path,
      setTimeout(() => {
        this.docTimers.delete(path);
        void this.rpc?.request({ kind: "docChanged", path, content, version: Date.now() });
      }, 200),
    );
  }

  async getCompletions(path: string, offset: number): Promise<CompletionsResult | null> {
    if (!this.isReady) return null;
    return (await this.rpc!.request({ kind: "completions", path, offset }).catch(() => null)) as CompletionsResult | null;
  }

  async getCompletionDetails(
    path: string,
    offset: number,
    item: CompletionItemData,
  ): Promise<DetailsResult | null> {
    if (!this.isReady) return null;
    return (await this.rpc!.request({
      kind: "completionDetails",
      path,
      offset,
      entryName: item.label,
      source: item.source,
      data: item.data,
    }).catch(() => null)) as DetailsResult | null;
  }

  async getDiagnostics(path: string): Promise<DiagnosticData[]> {
    if (!this.isReady) return [];
    return (await this.rpc!.request({ kind: "diagnostics", path }).catch(() => [])) as DiagnosticData[];
  }

  async getHover(path: string, offset: number): Promise<HoverResult | null> {
    if (!this.isReady) return null;
    return (await this.rpc!.request({ kind: "hover", path, offset }).catch(() => null)) as HoverResult | null;
  }

  async getDefinition(path: string, offset: number): Promise<DefinitionResult | null> {
    if (!this.isReady) return null;
    return (await this.rpc!.request({ kind: "definition", path, offset }).catch(() => null)) as DefinitionResult | null;
  }

  onTypesUpdated(fn: () => void): () => void {
    this.typesListeners.add(fn);
    return () => this.typesListeners.delete(fn);
  }
}

let singleton: Client | null = null;
export function tsClient(): TsClient {
  if (!singleton) singleton = new Client();
  return singleton;
}
