import type {
  CompletionItemData,
  CompletionsResult,
  DetailsResult,
  DiagnosticData,
  DefinitionResult,
  HoverResult,
} from "./ts-worker/protocol";

/** The contract the LSP client implements and the CodeMirror layer consumes.
 *  Offsets are UTF-16 doc offsets. */
export interface IntelligenceClient {
  openProject(root: string): Promise<void>;
  closeProject(): void;
  ready(): boolean;
  /** File became visible in the editor → LSP textDocument/didOpen. */
  notifyDocOpened(path: string, content: string): void;
  /** File content changed → LSP textDocument/didChange. */
  notifyDocChanged(path: string, content: string): void;
  /** File/tab closed → LSP textDocument/didClose. */
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

/** Per-language client manager: routes a file path to its language server's
 *  lazily-created client (or null when the language has no server). */
export { setProjectRoot, clientForPath, hasLspServer } from "./lsp/manager";
