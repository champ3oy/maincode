import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

// Colors extracted verbatim from `@pierre/theme` "pierre-dark" — the exact
// theme the diff/code-review view (@pierre/diffs) renders with. Driving the
// CodeMirror editor from the same palette makes the two surfaces match.
const c = {
  fg: "#fafafa",
  comment: "#737373",
  string: "#5ecc71",
  number: "#68cdf2",
  atom: "#68cdf2", // constant.language (boolean / null)
  constant: "#ffd452",
  keyword: "#ff678d",
  operator: "#08c0ef",
  punctuation: "#636363",
  variable: "#ffa359",
  func: "#9d6afb",
  type: "#d568ea",
  tag: "#ff855e",
  attribute: "#60d199",
  escape: "#61d5c0",
  regexp: "#64d1db",
  invalid: "#fafafa",
  cursor: "#009fff",
  selection: "#009fff4d",
  lineHighlight: "#19283c8c",
  lineNumber: "#737373",
  lineNumberActive: "#a3a3a3",
};

const pierreHighlight = HighlightStyle.define([
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: c.comment },
  {
    tag: [
      t.keyword,
      t.controlKeyword,
      t.moduleKeyword,
      t.definitionKeyword,
      t.operatorKeyword,
      t.modifier,
      t.self,
    ],
    color: c.keyword,
  },
  { tag: [t.operator, t.logicOperator, t.arithmeticOperator, t.compareOperator, t.bitwiseOperator], color: c.operator },
  { tag: [t.variableName, t.propertyName, t.attributeValue, t.deleted, t.macroName], color: c.variable },
  {
    tag: [
      t.function(t.variableName),
      t.function(t.propertyName),
      t.labelName,
      t.definition(t.function(t.variableName)),
    ],
    color: c.func,
  },
  { tag: [t.typeName, t.className, t.namespace, t.definition(t.typeName), t.standard(t.typeName)], color: c.type },
  { tag: [t.number, t.integer, t.float], color: c.number },
  { tag: [t.bool, t.null, t.atom], color: c.atom },
  { tag: [t.constant(t.variableName), t.constant(t.name)], color: c.constant },
  { tag: [t.string, t.special(t.string), t.docString], color: c.string },
  { tag: [t.regexp], color: c.regexp },
  { tag: [t.escape, t.character], color: c.escape },
  {
    tag: [
      t.punctuation,
      t.separator,
      t.bracket,
      t.paren,
      t.brace,
      t.squareBracket,
      t.angleBracket,
      t.derefOperator,
      t.meta,
    ],
    color: c.punctuation,
  },
  { tag: [t.tagName], color: c.tag },
  { tag: [t.attributeName], color: c.attribute },
  { tag: [t.heading], color: c.tag, fontWeight: "bold" },
  { tag: [t.strong], fontWeight: "bold" },
  { tag: [t.emphasis], fontStyle: "italic" },
  { tag: [t.strikethrough], textDecoration: "line-through" },
  { tag: [t.link], color: c.keyword, textDecoration: "underline" },
  { tag: [t.url], color: c.func },
  { tag: [t.invalid], color: c.invalid },
]);

const pierreTheme = EditorView.theme(
  {
    "&": { color: c.fg, backgroundColor: "transparent" },
    ".cm-content": { caretColor: c.cursor },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: c.cursor },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
      { backgroundColor: c.selection },
    ".cm-activeLine": { backgroundColor: c.lineHighlight },
    ".cm-gutters": {
      backgroundColor: "transparent",
      color: c.lineNumber,
      border: "none",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "transparent",
      color: c.lineNumberActive,
    },
    ".cm-foldPlaceholder": {
      backgroundColor: "transparent",
      border: "none",
      color: c.comment,
    },
    ".cm-selectionMatch": { backgroundColor: "#ffffff14" },
    "&.cm-focused .cm-matchingBracket, .cm-matchingBracket": {
      backgroundColor: "#ffffff1f",
      outline: "none",
    },
  },
  { dark: true },
);

// Restyles CodeMirror's built-in find/replace panel (@codemirror/search) to
// match the app: our inputs, buttons, and pierre-tinted match highlights.
// Uses app CSS variables so it adapts to light/dark automatically. Applied in
// both themes.
export const searchPanelTheme = EditorView.theme({
  ".cm-panels": {
    backgroundColor: "var(--popover)",
    color: "var(--foreground)",
    borderColor: "var(--border)",
  },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--border)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
  ".cm-panel.cm-search": {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "6px",
    padding: "6px 8px",
    fontSize: "12px",
    fontFamily: "inherit",
  },
  ".cm-panel.cm-search label": {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    fontSize: "11px",
    color: "var(--muted-foreground)",
  },
  ".cm-panel.cm-search input[type=checkbox]": {
    accentColor: c.cursor,
    margin: "0",
  },
  ".cm-textfield": {
    backgroundColor: "var(--background)",
    color: "var(--foreground)",
    border: "1px solid var(--border)",
    borderRadius: "6px",
    padding: "3px 8px",
    fontSize: "12px",
    outline: "none",
  },
  ".cm-textfield:focus": { borderColor: c.cursor },
  ".cm-button": {
    backgroundColor: "var(--muted)",
    backgroundImage: "none",
    color: "var(--foreground)",
    border: "1px solid var(--border)",
    borderRadius: "6px",
    padding: "3px 10px",
    fontSize: "12px",
    cursor: "pointer",
  },
  ".cm-button:hover": {
    backgroundColor: "var(--accent)",
    color: "var(--accent-foreground)",
  },
  ".cm-button:active": { backgroundImage: "none" },
  ".cm-panel.cm-search [name=close]": {
    color: "var(--muted-foreground)",
    fontSize: "16px",
    padding: "0 4px",
    cursor: "pointer",
  },
  ".cm-panel.cm-search [name=close]:hover": { color: "var(--foreground)" },
  ".cm-searchMatch": {
    backgroundColor: "rgba(255, 171, 22, 0.22)",
    borderRadius: "2px",
  },
  ".cm-searchMatch-selected": {
    backgroundColor: "rgba(255, 103, 141, 0.45)",
  },
});

/** Dark editor theme built from pierre-dark's exact palette. */
export function pierreDark(): Extension {
  return [pierreTheme, syntaxHighlighting(pierreHighlight)];
}
