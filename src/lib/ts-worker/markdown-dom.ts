// Small markdown → DOM renderer for TS hover docs.
//
// SECURITY: this renders JSDoc pulled from arbitrary node_modules — untrusted
// input. It NEVER assigns innerHTML; every node is built via the DOM API
// (createElement / createTextNode / appendChild), so there is zero HTML-parsing
// surface and thus zero XSS risk. Unmatched markup markers are emitted as
// literal text rather than being interpreted. Code-block syntax highlighting
// (highlightCodeToDom) is also DOM-only — token text goes through createTextNode.
//
// Supported subset (intentionally small):
//   - Fenced code blocks:  ```lang\n…\n```  → <pre class="cm-ts-hover-code"><code>…</code></pre>
//                                             (JS/TS-family blocks are syntax-highlighted)
//   - Paragraphs (blank-line separated)     → <p>
//   - Inline (within paragraphs):
//       `code`                              → <code>
//       **bold** / __bold__                 → <strong>
//       *italic* / _italic_                 → <em>
//       [text](url)                         → <a title="url"> (text only; no navigation)
//       {@link X} / {@linkcode X}           → <code> (styled X)

import { highlightCodeToDom, isTsFamily } from "./code-highlight";

/**
 * Render a markdown string into a DocumentFragment. Safe for untrusted input:
 * never uses innerHTML.
 */
export function renderMarkdown(md: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const blocks = splitBlocks(md);
  for (const block of blocks) {
    if (block.type === "code") {
      const pre = document.createElement("pre");
      pre.className = "cm-ts-hover-code";
      const code = document.createElement("code");
      if (isTsFamily(block.lang)) {
        code.appendChild(highlightCodeToDom(block.text));
      } else {
        code.appendChild(document.createTextNode(block.text));
      }
      pre.appendChild(code);
      frag.appendChild(pre);
    } else {
      const p = document.createElement("p");
      appendInline(p, block.text);
      frag.appendChild(p);
    }
  }
  return frag;
}

type Block = { type: "code"; text: string; lang: string } | { type: "para"; text: string };

/**
 * Split markdown into fenced-code and paragraph blocks. Fenced blocks are
 * detected first (a line whose trimmed form starts with ```), everything
 * between fences is captured verbatim, and the remaining text is split into
 * paragraphs on blank lines.
 */
function splitBlocks(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];

  const flushPara = () => {
    // Coalesce the accumulated non-fence lines into blank-line-separated paragraphs.
    const text = para.join("\n");
    para = [];
    for (const chunk of text.split(/\n{2,}/)) {
      const trimmed = chunk.trim();
      if (trimmed) blocks.push({ type: "para", text: trimmed });
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const fence = lines[i].trimStart();
    if (fence.startsWith("```")) {
      flushPara();
      // The opening line's info string is the language (e.g. ```tsx → "tsx").
      const lang = fence.slice(3).trim();
      // Consume until the closing fence (or EOF).
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) {
        body.push(lines[i]);
        i++;
      }
      // `i` now sits on the closing fence (or past EOF); the for-loop's i++ skips it.
      blocks.push({ type: "code", text: body.join("\n"), lang });
    } else {
      para.push(lines[i]);
    }
  }
  flushPara();
  return blocks;
}

// Inline markers, longest-first so `**`/`__` win over `*`/`_`.
type Match = { end: number; node: Node };

/**
 * Parse inline markdown within a paragraph segment, appending text and element
 * nodes to `parent`. Scans left-to-right; at each position it tries the inline
 * constructs in priority order. Any marker that doesn't find its closing
 * delimiter is emitted as a literal character (via the trailing text run).
 */
function appendInline(parent: Node, text: string): void {
  let run = ""; // buffered plain text not yet flushed
  const flush = () => {
    if (run) {
      parent.appendChild(document.createTextNode(run));
      run = "";
    }
  };

  let i = 0;
  while (i < text.length) {
    const m = matchAt(text, i);
    if (m) {
      flush();
      parent.appendChild(m.node);
      i = m.end;
    } else {
      run += text[i];
      i++;
    }
  }
  flush();
}

/** Try to match an inline construct starting at index `i`. Returns null if none. */
function matchAt(text: string, i: number): Match | null {
  const ch = text[i];

  // Inline code: `code`  (single backtick pair; no nested backticks)
  if (ch === "`") {
    const close = text.indexOf("`", i + 1);
    if (close > i) {
      const code = document.createElement("code");
      code.appendChild(document.createTextNode(text.slice(i + 1, close)));
      return { end: close + 1, node: code };
    }
    return null;
  }

  // JSDoc {@link X} / {@linkcode X}  → <code>X</code>
  if (ch === "{" && text.startsWith("{@link", i)) {
    const close = text.indexOf("}", i);
    if (close > i) {
      const inner = text.slice(i, close + 1);
      const parsed = /^\{@link(?:code|plain)?\s+([^}]*)\}$/.exec(inner);
      if (parsed) {
        const code = document.createElement("code");
        code.appendChild(document.createTextNode(parsed[1].trim()));
        return { end: close + 1, node: code };
      }
    }
    return null;
  }

  // Link: [text](url)
  if (ch === "[") {
    const closeBracket = text.indexOf("]", i + 1);
    if (closeBracket > i && text[closeBracket + 1] === "(") {
      const closeParen = text.indexOf(")", closeBracket + 2);
      if (closeParen > closeBracket) {
        const label = text.slice(i + 1, closeBracket);
        const url = text.slice(closeBracket + 2, closeParen);
        const a = document.createElement("a");
        a.appendChild(document.createTextNode(label));
        a.title = url; // no navigation — styled affordance only
        return { end: closeParen + 1, node: a };
      }
    }
    return null;
  }

  // Bold: **bold** or __bold__  (checked before italic so ** wins over *)
  const bold = matchDelimited(text, i, "**") ?? matchDelimited(text, i, "__");
  if (bold) {
    const strong = document.createElement("strong");
    appendInline(strong, bold.inner);
    return { end: bold.end, node: strong };
  }

  // Italic: *italic* or _italic_
  const italic = matchDelimited(text, i, "*") ?? matchDelimited(text, i, "_");
  if (italic) {
    const em = document.createElement("em");
    appendInline(em, italic.inner);
    return { end: italic.end, node: em };
  }

  return null;
}

/**
 * Match `delim…delim` starting at `i`. Returns the inner text and the index one
 * past the closing delimiter, or null if the marker isn't closed (so it stays
 * literal). Empty spans (e.g. `**` immediately closed) are rejected.
 */
function matchDelimited(
  text: string,
  i: number,
  delim: string,
): { inner: string; end: number } | null {
  if (!text.startsWith(delim, i)) return null;
  const from = i + delim.length;
  const close = text.indexOf(delim, from);
  if (close <= from) return null; // unclosed or empty
  return { inner: text.slice(from, close), end: close + delim.length };
}
