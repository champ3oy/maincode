/**
 * cm-setup.ts — base editor extensions + toggleable autocomplete/lint builders.
 *
 * `baseSetup` replicates `basicSetup` from `codemirror` verbatim **minus
 * `autocompletion()`**, so that we can provide our own toggleable version.
 *
 * Autocomplete and lint are provided as builder functions that accept an
 * `enabled` flag and (for lint) the current language key, and return the
 * appropriate extensions. They are controlled by compartments in code-editor.tsx.
 */

import {
  lineNumbers,
  highlightActiveLineGutter,
  highlightSpecialChars,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  highlightActiveLine,
  keymap,
} from "@codemirror/view";
import { EditorState, type Extension } from "@codemirror/state";
import {
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
  defaultHighlightStyle,
  bracketMatching,
  syntaxTree,
} from "@codemirror/language";
import { history, defaultKeymap, historyKeymap } from "@codemirror/commands";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import {
  closeBrackets,
  autocompletion,
  closeBracketsKeymap,
  completionKeymap,
  completeAnyWord,
} from "@codemirror/autocomplete";
import {
  lintKeymap,
  lintGutter,
  linter,
  type Diagnostic,
} from "@codemirror/lint";
import { jsonParseLinter } from "@codemirror/lang-json";
import type { CompletionSource } from "@codemirror/autocomplete";
import type { LanguageKey } from "./language";

// ---------------------------------------------------------------------------
// baseSetup — basicSetup contents minus autocompletion()
// ---------------------------------------------------------------------------

/**
 * Drop-in replacement for `basicSetup` with `autocompletion()` removed so we
 * can provide a toggleable version via a Compartment.
 *
 * Contents (verbatim from codemirror/dist/index.js):
 *   lineNumbers, highlightActiveLineGutter, highlightSpecialChars, history,
 *   foldGutter, drawSelection, dropCursor,
 *   EditorState.allowMultipleSelections, indentOnInput,
 *   syntaxHighlighting(defaultHighlightStyle), bracketMatching,
 *   closeBrackets, rectangularSelection, crosshairCursor,
 *   highlightActiveLine, highlightSelectionMatches,
 *   keymap(closeBracketsKeymap + defaultKeymap + searchKeymap +
 *          historyKeymap + foldKeymap + completionKeymap + lintKeymap)
 *
 * Omitted from basicSetup: autocompletion() — provided by completionExtensions().
 */
export const baseSetup: Extension = (() => [
  lineNumbers(),
  highlightActiveLineGutter(),
  highlightSpecialChars(),
  history(),
  foldGutter(),
  drawSelection(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  indentOnInput(),
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  bracketMatching(),
  closeBrackets(),
  // autocompletion() intentionally omitted — see completionExtensions()
  rectangularSelection(),
  crosshairCursor(),
  highlightActiveLine(),
  highlightSelectionMatches(),
  keymap.of([
    ...closeBracketsKeymap,
    ...defaultKeymap,
    ...searchKeymap,
    ...historyKeymap,
    ...foldKeymap,
    ...completionKeymap,
    ...lintKeymap,
  ]),
])();

// ---------------------------------------------------------------------------
// completionExtensions — toggleable autocompletion
// ---------------------------------------------------------------------------

/**
 * Returns autocompletion extensions when enabled, or an empty array.
 *
 * `completeAnyWord` is registered as a global additional source via
 * `EditorState.languageData` so it supplements (not overrides) language-
 * specific sources on every language.
 *
 * When `ts` is provided, the TS completion source is added alongside
 * `completeAnyWord`. TS results are boosted so they rank first; word
 * completions remain the warm-up fallback. The TS source self-gates on
 * `isTsWorkerPath` and the intelligence client's `ready()` so it can be
 * registered unconditionally.
 */
export function completionExtensions(
  enabled: boolean,
  ts?: { source: CompletionSource },
): Extension {
  if (!enabled) return [];
  const sources = ts
    ? [{ autocomplete: completeAnyWord }, { autocomplete: ts.source }]
    : [{ autocomplete: completeAnyWord }];
  return [
    autocompletion(),
    EditorState.languageData.of(() => sources),
  ];
}

// ---------------------------------------------------------------------------
// lintExtensions — toggleable linting
// ---------------------------------------------------------------------------

const MAX_DIAGNOSTICS = 100;

/**
 * Syntax-error linter using Lezer's parse tree. Walks the tree and emits a
 * Diagnostic for every error node, capped at MAX_DIAGNOSTICS per pass.
 */
const syntaxErrorLinter = linter((view) => {
  const diagnostics: Diagnostic[] = [];
  syntaxTree(view.state).iterate({
    enter(node) {
      if (diagnostics.length >= MAX_DIAGNOSTICS) return false;
      if (node.type.isError) {
        diagnostics.push({
          from: node.from,
          to: Math.max(node.to, node.from + 1),
          severity: "error",
          message: "Syntax error",
        });
      }
    },
  });
  return diagnostics;
});

/**
 * Returns lint extensions when enabled, or an empty array.
 *
 * Always includes: `lintGutter()`.
 * For JSON files: also includes `jsonParseLinter()` for precise parse errors
 *   (Lezer syntax linter unchanged).
 * When `ts` is provided:
 *   - kind "ts": Lezer syntax linter OMITTED; TS linter + hover replaces it.
 *   - kind "js": Lezer syntax linter kept AND TS linter/hover added (no dedupe v1).
 */
export function lintExtensions(
  enabled: boolean,
  languageKey: LanguageKey | null,
  ts?: { linter: Extension; hover: Extension; kind: "ts" | "js" },
): Extension {
  if (!enabled) return [];
  const extensions: Extension[] = [lintGutter()];
  if (languageKey === "json") {
    // JSON: Lezer for syntax + json-specific parse linter; no TS worker.
    extensions.push(syntaxErrorLinter, linter(jsonParseLinter()));
  } else if (ts) {
    if (ts.kind === "ts") {
      // TS/TSX: TS diagnostics replace Lezer syntax linter.
      extensions.push(ts.linter, ts.hover);
    } else {
      // JS/JSX: keep Lezer + add TS diagnostics (dedupe not required v1).
      extensions.push(syntaxErrorLinter, ts.linter, ts.hover);
    }
  } else {
    // No TS worker: Lezer syntax linter only.
    extensions.push(syntaxErrorLinter);
  }
  return extensions;
}
