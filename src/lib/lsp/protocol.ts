// LSP position/URI helpers + the message-type subset we use. LSP positions are
// 0-based {line, character} in UTF-16 code units; JS strings are UTF-16, so a
// character is a plain string index within its line.

export interface LspPosition { line: number; character: number }
export interface LspRange { start: LspPosition; end: LspPosition }
export interface LspDiagnostic {
  range: LspRange;
  severity?: 1 | 2 | 3 | 4; // Error | Warning | Information | Hint
  message: string;
}
export interface LspLocation { uri: string; range: LspRange }
export interface LspHover {
  contents: string | { value: string } | { kind: string; value: string } | Array<string | { value: string }>;
  range?: LspRange;
}
export interface LspCompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  sortText?: string;
  insertText?: string;
  textEdit?: { range: LspRange; newText: string };
  additionalTextEdits?: { range: LspRange; newText: string }[];
  data?: unknown;
}

/** 0-based {line, character} for a UTF-16 offset into `text`. */
export function offsetToPosition(text: string, offset: number): LspPosition {
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, character: offset - lineStart };
}

/** UTF-16 offset for a 0-based {line, character}; clamps to line/doc bounds. */
export function positionToOffset(text: string, pos: LspPosition): number {
  let offset = 0;
  let line = 0;
  while (line < pos.line) {
    const nl = text.indexOf("\n", offset);
    if (nl === -1) return text.length;
    offset = nl + 1;
    line++;
  }
  const lineEnd = text.indexOf("\n", offset);
  const maxChar = (lineEnd === -1 ? text.length : lineEnd) - offset;
  return offset + Math.min(pos.character, maxChar);
}

export function pathToUri(path: string): string {
  const enc = path
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  return `file://${enc}`;
}

export function uriToPath(uri: string): string {
  return decodeURIComponent(uri.replace(/^file:\/\//, ""));
}
