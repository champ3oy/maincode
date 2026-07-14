import type {
  CompletionItemData,
  CompletionsResult,
  DetailsResult,
  DiagnosticData,
  DefinitionResult,
  HoverResult,
} from "./ts-worker/protocol";
import { LspClient } from "./lsp/client";
import { tsClient } from "./ts-worker/client";

/** The contract both the in-browser worker and the LSP client implement, so the
 *  CodeMirror layer is engine-agnostic. Offsets are UTF-16 doc offsets. */
export interface IntelligenceClient {
  openProject(root: string): Promise<void>;
  closeProject(): void;
  ready(): boolean;
  /** File became visible in the editor (LSP didOpen; worker: load into VFS). */
  notifyDocOpened(path: string, content: string): void;
  /** File content changed (LSP didChange; worker: docChanged). */
  notifyDocChanged(path: string, content: string): void;
  /** File/tab closed (LSP didClose; worker: no-op). */
  notifyDocClosed(path: string): void;
  getCompletions(path: string, offset: number): Promise<CompletionsResult | null>;
  getCompletionDetails(
    path: string,
    offset: number,
    item: CompletionItemData,
  ): Promise<DetailsResult | null>;
  getDiagnostics(path: string): Promise<DiagnosticData[]>;
  getHover(path: string, offset: number): Promise<HoverResult | null>;
  getDefinition(path: string, offset: number): Promise<DefinitionResult | null>;
  /** Fires when pushed diagnostics arrive so the editor re-lints. */
  onTypesUpdated(fn: () => void): () => void;
}

let lspSingleton: LspClient | null = null;

/** Returns the active intelligence engine for the current setting. */
export function intelligenceClient(engine: "worker" | "lsp"): IntelligenceClient {
  if (engine === "lsp") {
    if (!lspSingleton) lspSingleton = new LspClient();
    return lspSingleton;
  }
  return tsClient();
}
