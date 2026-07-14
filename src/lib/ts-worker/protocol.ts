// Shared result types for the editor's TypeScript/JS intelligence, produced by
// the LSP client and consumed by the CodeMirror extensions + hover renderer.
// Offsets are UTF-16 document offsets (CodeMirror convention).

export interface CompletionItemData {
  label: string;
  kind: string; // ts.ScriptElementKind-style string, e.g. "var", "method", "keyword"
  detail?: string; // e.g. source module for auto-imports: "react"
  sortText: string;
  insertText?: string;
  source?: string; // present when the entry needs details to apply (auto-import)
  data?: unknown; // opaque, passed back for completion resolve
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
  kind: string; // display-part kind for coloring; "code" → syntax-highlight the text
}

export interface HoverResult {
  signature: HoverPart[]; // the type signature, structured for rendering
  documentation: string; // markdown docs (may be "")
  tags: { name: string; text: string }[]; // JSDoc tags: @example/@param/@returns/…
}

// Go-to-definition target. line/column are 1-based (CodeMirror convention),
// `path` is the target file's absolute path (may point under node_modules).
export interface DefinitionResult {
  path: string;
  line: number;
  column: number;
}
