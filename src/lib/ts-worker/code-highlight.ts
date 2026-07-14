// Syntax-highlight a code string into DOM, reusing CodeMirror's Lezer parser +
// the editor's active HighlightStyle so hover code blocks match the editor theme.
//
// It relies on the HighlightStyle's global CSS module already being mounted by
// the live editor (baseSetup mounts defaultHighlightStyle always; pierreDark
// mounts pierreHighlight in dark mode). We pick the style by the current theme
// so the emitted classes resolve to the right colors. Untrusted code is only
// ever inserted via createTextNode — no innerHTML, so no XSS surface.

import { javascript } from "@codemirror/lang-javascript";
import { defaultHighlightStyle } from "@codemirror/language";
import { highlightTree } from "@lezer/highlight";
import { pierreHighlight } from "../cm-theme";

// One TSX parser covers js/jsx/ts/tsx (the superset) — enough for hover snippets.
const tsxParser = javascript({ typescript: true, jsx: true }).language.parser;

/** Languages we highlight with the JS/TS parser. Others render as plain text. */
const TS_FAMILY = new Set([
  "",
  "ts",
  "tsx",
  "js",
  "jsx",
  "javascript",
  "typescript",
  "javascriptreact",
  "typescriptreact",
]);

export function isTsFamily(lang: string): boolean {
  return TS_FAMILY.has(lang.trim().toLowerCase());
}

/**
 * Highlight a code string into a DocumentFragment of colored <span>s. Falls back
 * to a single text node if parsing throws.
 */
export function highlightCodeToDom(code: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const dark = document.documentElement.classList.contains("dark");
  const style = dark ? pierreHighlight : defaultHighlightStyle;
  let tree;
  try {
    tree = tsxParser.parse(code);
  } catch {
    frag.appendChild(document.createTextNode(code));
    return frag;
  }
  let pos = 0;
  highlightTree(tree, style, (from, to, classes) => {
    if (from > pos) frag.appendChild(document.createTextNode(code.slice(pos, from)));
    const span = document.createElement("span");
    span.className = classes;
    span.appendChild(document.createTextNode(code.slice(from, to)));
    frag.appendChild(span);
    pos = to;
  });
  if (pos < code.length) frag.appendChild(document.createTextNode(code.slice(pos)));
  return frag;
}
