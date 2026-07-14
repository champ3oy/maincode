import type {
  CompletionItemData,
  CompletionsResult,
  DetailsResult,
  DiagnosticData,
  DefinitionResult,
  HoverResult,
} from "../ts-worker/protocol";
import type { IntelligenceClient, LspProgress } from "../intelligence";
import { invoke } from "@tauri-apps/api/core";
import { spawnServer, type Transport } from "./transport";
import {
  offsetToPosition,
  positionToOffset,
  pathToUri,
  uriToPath,
  type LspCompletionItem,
  type LspDiagnostic,
  type LspHover,
  type LspLocation,
} from "./protocol";

type Spawn = (serverId: string, root: string) => Promise<{ id: number; transport: Transport }>;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

const SEVERITY: Record<number, DiagnosticData["severity"]> = { 1: "error", 2: "warning", 3: "info", 4: "info" };

export class LspClient implements IntelligenceClient {
  private transport: Transport | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly docs = new Map<string, string>(); // path -> current text
  private readonly openedOnServer = new Set<string>(); // paths for which didOpen has been sent
  private readonly diagnostics = new Map<string, LspDiagnostic[]>(); // uri -> diags
  private readonly typesListeners = new Set<() => void>();
  // Work-done progress, keyed by token. rust-analyzer runs several concurrently
  // (Fetching, Indexing, Building…); we surface the most-recently-updated one.
  private readonly progressTokens = new Map<string | number, LspProgress>();
  private readonly progressListeners = new Set<(p: LspProgress | null) => void>();
  private isReady = false;

  constructor(
    private readonly serverId: string,
    private readonly spawn: Spawn = spawnServer,
  ) {}

  async openProject(root: string): Promise<void> {
    this.closeProject();
    const [{ transport }, initOptions] = await Promise.all([
      this.spawn(this.serverId, root),
      invoke<unknown>("lsp_init_options", { serverId: this.serverId }).catch(() => null),
    ]);
    this.transport = transport;
    transport.onMessage((m) => this.onMessage(m));
    transport.onExit(() => (this.isReady = false));
    await this.request("initialize", {
      processId: null,
      rootUri: pathToUri(root),
      capabilities: {
        textDocument: {
          synchronization: { didSave: false },
          completion: { completionItem: { snippetSupport: false } },
          hover: { contentFormat: ["markdown", "plaintext"] },
          definition: {},
          publishDiagnostics: {},
        },
        // Opt into server-initiated progress so rust-analyzer (and others) report
        // indexing/build progress via `window/workDoneProgress/create` + `$/progress`.
        window: { workDoneProgress: true },
      },
      workspaceFolders: [{ uri: pathToUri(root), name: root }],
      initializationOptions: initOptions ?? undefined,
    });
    this.notify("initialized", {});
    this.isReady = true;
    // Replay didOpen for any docs opened while we were still initializing.
    for (const [path, content] of this.docs) this.sendDidOpen(path, content);
  }

  closeProject(): void {
    this.isReady = false;
    this.pending.clear();
    this.docs.clear();
    this.openedOnServer.clear();
    this.diagnostics.clear();
    this.progressTokens.clear();
    this.progressListeners.forEach((fn) => fn(null));
    this.transport?.dispose();
    this.transport = null;
  }

  ready(): boolean {
    return this.isReady;
  }

  private sendDidOpen(path: string, content: string): void {
    this.notify("textDocument/didOpen", {
      textDocument: { uri: pathToUri(path), languageId: languageId(path), version: 1, text: content },
    });
    this.openedOnServer.add(path);
  }

  notifyDocOpened(path: string, content: string): void {
    this.docs.set(path, content);
    if (this.isReady) this.sendDidOpen(path, content);
  }

  notifyDocChanged(path: string, content: string): void {
    this.docs.set(path, content);
    if (!this.isReady) return;
    if (this.openedOnServer.has(path)) {
      this.notify("textDocument/didChange", {
        textDocument: { uri: pathToUri(path), version: Date.now() },
        contentChanges: [{ text: content }], // full-document sync
      });
    } else {
      this.sendDidOpen(path, content);
    }
  }

  notifyDocClosed(path: string): void {
    this.docs.delete(path);
    if (this.isReady && this.openedOnServer.delete(path)) {
      this.notify("textDocument/didClose", { textDocument: { uri: pathToUri(path) } });
    }
  }

  async getDiagnostics(path: string): Promise<DiagnosticData[]> {
    const text = this.docs.get(path);
    const diags = this.diagnostics.get(pathToUri(path));
    if (!text || !diags) return [];
    return diags.map((d) => ({
      from: positionToOffset(text, d.range.start),
      to: positionToOffset(text, d.range.end),
      severity: SEVERITY[d.severity ?? 1] ?? "error",
      message: d.message,
    }));
  }

  async getHover(path: string, offset: number): Promise<HoverResult | null> {
    const text = this.docs.get(path);
    if (!this.isReady || !text) return null;
    const res = (await this.request("textDocument/hover", {
      textDocument: { uri: pathToUri(path) },
      position: offsetToPosition(text, offset),
    }).catch(() => null)) as LspHover | null;
    if (!res || !res.contents) return null;
    const md = hoverToMarkdown(res.contents);
    if (!md) return null;
    // LSP hover is a single markdown string that (for TS) leads with a ```ts
    // fenced type signature, then prose docs. Split so the signature renders in
    // the monospace signature block and the rest flows through the markdown
    // renderer (code blocks, @example, italics) instead of showing raw fences.
    return splitHoverMarkdown(md);
  }

  async getDefinition(path: string, offset: number): Promise<DefinitionResult | null> {
    const text = this.docs.get(path);
    if (!this.isReady || !text) return null;
    const res = (await this.request("textDocument/definition", {
      textDocument: { uri: pathToUri(path) },
      position: offsetToPosition(text, offset),
    }).catch(() => null)) as LspLocation | LspLocation[] | null;
    const loc = Array.isArray(res) ? res[0] : res;
    if (!loc) return null;
    return {
      path: uriToPath(loc.uri),
      line: loc.range.start.line + 1,
      column: loc.range.start.character + 1,
    };
  }

  async getCompletions(path: string, offset: number): Promise<CompletionsResult | null> {
    const text = this.docs.get(path);
    if (!this.isReady || !text) return null;
    const res = (await this.request("textDocument/completion", {
      textDocument: { uri: pathToUri(path) },
      position: offsetToPosition(text, offset),
    }).catch(() => null)) as { items?: LspCompletionItem[] } | LspCompletionItem[] | null;
    const items = Array.isArray(res) ? res : res?.items;
    if (!items || items.length === 0) return null;
    return {
      fromOffset: offset,
      items: items.slice(0, 300).map((i) => ({
        label: i.label,
        kind: String(i.kind ?? ""),
        detail: i.detail,
        sortText: i.sortText ?? "",
        insertText: i.insertText ?? i.textEdit?.newText,
        source: undefined,
        data: i.data,
      })),
    } as CompletionsResult;
  }

  async getCompletionDetails(
    _path: string,
    _offset: number,
    _item: CompletionItemData,
  ): Promise<DetailsResult | null> {
    // v1: no server-side resolve wiring yet; auto-import edits arrive with the
    // completion item itself (additionalTextEdits) in a follow-up.
    return { extraChanges: [] };
  }

  onTypesUpdated(fn: () => void): () => void {
    this.typesListeners.add(fn);
    return () => this.typesListeners.delete(fn);
  }

  /** Subscribe to work-done progress (indexing/building). Fires with the current
   *  progress, or null when nothing is in flight. */
  onProgress(fn: (p: LspProgress | null) => void): () => void {
    this.progressListeners.add(fn);
    return () => this.progressListeners.delete(fn);
  }

  private onProgressMessage(token: string | number | undefined, value: any): void {
    if (token === undefined || !value) return;
    if (value.kind === "end") {
      this.progressTokens.delete(token);
    } else {
      // Re-insert so the most-recently-updated token sorts last (shown by emitProgress).
      const prev = this.progressTokens.get(token);
      const isReport = value.kind === "report";
      this.progressTokens.delete(token);
      this.progressTokens.set(token, {
        title: value.title ?? prev?.title ?? "",
        message: value.message ?? (isReport ? prev?.message : undefined),
        percentage: value.percentage ?? (isReport ? prev?.percentage : undefined),
      });
    }
    this.emitProgress();
  }

  private emitProgress(): void {
    const vals = [...this.progressTokens.values()];
    const current = vals.length ? vals[vals.length - 1] : null;
    this.progressListeners.forEach((fn) => fn(current));
  }

  // ---- JSON-RPC plumbing ----
  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      void this.transport?.send(payload).catch((e) => {
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      });
    });
  }

  private notify(method: string, params: unknown): void {
    void this.transport?.send(JSON.stringify({ jsonrpc: "2.0", method, params })).catch(() => {});
  }

  private onMessage(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? "LSP error"));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === "textDocument/publishDiagnostics") {
      this.diagnostics.set(msg.params.uri, msg.params.diagnostics ?? []);
      this.typesListeners.forEach((fn) => fn());
    }
    if (msg.method === "$/progress") {
      this.onProgressMessage(msg.params?.token, msg.params?.value);
      return;
    }
    // Server→client requests (e.g. registerCapability) get a null result so the
    // server isn't left waiting.
    if (msg.id !== undefined && msg.method) {
      void this.transport?.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: null }));
    }
  }
}

// LSP languageId for a path. Servers key document handling off this, so it must
// match the actual language — not a blanket "typescript" (the prior bug, which
// only happened to work because rust-analyzer/pyright ignore it).
const LANGUAGE_ID: Record<string, string> = {
  ts: "typescript", tsx: "typescriptreact",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascriptreact",
  py: "python", rs: "rust", go: "go",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
  json: "json", jsonc: "jsonc", html: "html", htm: "html", css: "css",
  yaml: "yaml", yml: "yaml", sh: "shellscript", bash: "shellscript",
  vue: "vue", svelte: "svelte", graphql: "graphql", gql: "graphql",
};
function languageId(path: string): string {
  const lower = path.toLowerCase();
  if (/(^|\/)dockerfile$/.test(lower) || lower.endsWith(".dockerfile")) return "dockerfile";
  const ext = lower.slice(lower.lastIndexOf(".") + 1);
  return LANGUAGE_ID[ext] ?? "plaintext";
}

function hoverToMarkdown(contents: LspHover["contents"]): string {
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) return contents.map((c) => (typeof c === "string" ? c : c.value)).join("\n\n");
  return (contents as { value: string }).value ?? "";
}

/**
 * Split LSP hover markdown into a signature + documentation `HoverResult`. If the
 * markdown leads with a fenced code block (the type signature, which is how
 * tsserver formats it), that block's body becomes the signature and the rest
 * becomes markdown documentation. Otherwise it all goes to documentation.
 */
function splitHoverMarkdown(md: string): HoverResult {
  const m = /^\s*```[^\n]*\n([\s\S]*?)\n?```\s*/.exec(md);
  if (m) {
    const sig = m[1].trim();
    const rest = md.slice(m[0].length).trim();
    // kind "code" tells the renderer to syntax-highlight this signature block.
    return { signature: [{ text: sig, kind: "code" }], documentation: rest, tags: [] };
  }
  return { signature: [], documentation: md.trim(), tags: [] };
}
