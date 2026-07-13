// protocol.ts - Types and RPC helper for TypeScript worker communication

export interface FileEntry {
  path: string;
  content: string | null; // null = does not exist
}

export interface CompletionItemData {
  label: string;
  kind: string; // ts.ScriptElementKind string, e.g. "var", "method", "keyword"
  detail?: string; // e.g. source module for auto-imports: "react"
  sortText: string;
  insertText?: string;
  // present when the entry is an auto-import candidate (needs details to apply)
  source?: string;
  data?: unknown; // ts.CompletionEntryData, passed back opaquely
}

export interface CompletionsResult {
  items: CompletionItemData[];
  fromOffset: number;
}

export interface DetailsResult {
  // concatenated text changes to ALSO apply (auto-import edits), doc-ordered
  extraChanges: { from: number; to: number; insert: string }[];
}

export interface DiagnosticData {
  from: number;
  to: number;
  severity: "error" | "warning" | "info";
  message: string;
}

export interface HoverPart {
  text: string;
  kind: string; // ts SymbolDisplayPart.kind, e.g. "keyword", "functionName", "punctuation"
}

export interface HoverResult {
  signature: HoverPart[]; // info.displayParts, structured (for syntax coloring)
  documentation: string; // FULL markdown (info.documentation flattened) — may be ""
  tags: { name: string; text: string }[]; // JSDoc tags: @example/@param/@returns/etc.
}

// Go-to-definition target. line/column are 1-based (CodeMirror convention),
// mapped in the worker from TS's 0-based offset via the target source file's
// line map. `path` is the target file's real absolute path — may point under
// node_modules (a .d.ts); those files exist on disk and the editor can open them.
export interface DefinitionResult {
  path: string;
  line: number;
  column: number;
}

export type WorkerRequest =
  | { kind: "openProject"; root: string; files: { path: string; content: string }[]; tsconfigText: string | null }
  | { kind: "docChanged"; path: string; content: string; version: number }
  | { kind: "completions"; path: string; offset: number }
  | { kind: "completionDetails"; path: string; offset: number; entryName: string; source?: string; data?: unknown }
  | { kind: "diagnostics"; path: string }
  | { kind: "hover"; path: string; offset: number }
  | { kind: "definition"; path: string; offset: number }
  | { kind: "filesLoaded"; files: FileEntry[] };

export type WorkerNotification =
  | { kind: "needFiles"; paths: string[] }
  | { kind: "typesUpdated" }; // node_modules types arrived → clients should re-query

export type RpcPort = {
  postMessage(msg: unknown): void;
  addEventListener(type: "message", fn: (e: MessageEvent) => void): void;
};

// Envelope: { id?: number, t: "req" | "res" | "err" | "notify", p: unknown }
export function createRpc(
  port: RpcPort,
  onRequest: (payload: unknown) => Promise<unknown> | unknown,
  onNotify?: (payload: unknown) => void,
) {
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  port.addEventListener("message", (e) => {
    const msg = e.data as { id?: number; t: string; p: unknown };
    if (!msg || typeof msg.t !== "string") return;
    if (msg.t === "req") {
      Promise.resolve()
        .then(() => onRequest(msg.p))
        .then(
          (result) => port.postMessage({ id: msg.id, t: "res", p: result }),
          (err) => port.postMessage({ id: msg.id, t: "err", p: err instanceof Error ? err.message : String(err) }),
        );
    } else if (msg.t === "res" || msg.t === "err") {
      const entry = msg.id !== undefined ? pending.get(msg.id) : undefined;
      if (!entry) return;
      pending.delete(msg.id!);
      if (msg.t === "res") entry.resolve(msg.p);
      else entry.reject(new Error(String(msg.p)));
    } else if (msg.t === "notify") {
      onNotify?.(msg.p);
    }
  });

  return {
    request(payload: unknown): Promise<unknown> {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        port.postMessage({ id, t: "req", p: payload });
      });
    },
    notify(payload: unknown): void {
      port.postMessage({ t: "notify", p: payload });
    },
  };
}
