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
 */
export function completionExtensions(enabled: boolean): Extension {
  if (!enabled) return [];
  return [
    autocompletion(),
    EditorState.languageData.of(() => [{ autocomplete: completeAnyWord }]),
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
 * Always includes: `lintGutter()` + the Lezer syntax-error linter.
 * For JSON files, also includes `jsonParseLinter()` for precise parse errors.
 */
export function lintExtensions(
  enabled: boolean,
  languageKey: LanguageKey | null,
): Extension {
  if (!enabled) return [];
  const extensions: Extension[] = [lintGutter(), syntaxErrorLinter];
  if (languageKey === "json") {
    extensions.push(linter(jsonParseLinter()));
  }
  return extensions;
}
