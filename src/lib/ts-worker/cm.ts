import { type Completion, type CompletionResult, type CompletionSource } from "@codemirror/autocomplete";
import { linter, type Diagnostic } from "@codemirror/lint";
import { hoverTooltip, type Extension } from "@codemirror/view";
import { isTsWorkerPath, tsClient } from "./client";
import type { CompletionItemData } from "./protocol";

const KIND_MAP: Record<string, string> = {
  var: "variable", let: "variable", const: "variable", "local var": "variable",
  function: "function", "local function": "function", method: "method",
  property: "property", getter: "property", setter: "property",
  class: "class", interface: "interface", enum: "enum", "enum member": "constant",
  module: "namespace", keyword: "keyword", string: "text", alias: "variable",
  type: "type", "type parameter": "type", parameter: "variable",
};

function toCompletion(item: CompletionItemData, path: string, offset: number): Completion {
  const c: Completion = {
    label: item.label,
    type: KIND_MAP[item.kind] ?? "text",
    detail: item.detail,
    boost: item.sortText.startsWith("0") ? 2 : 1, // TS sorts best matches into "0…"
  };
  if (item.source) {
    // auto-import entry: on apply, insert the label AND the import edits.
    c.apply = (view, _completion, from, to) => {
      view.dispatch({ changes: { from, to, insert: item.insertText ?? item.label } });
      void tsClient()
        .getCompletionDetails(path, offset, item)
        .then((details) => {
          if (!details || details.extraChanges.length === 0) return;
          view.dispatch({ changes: details.extraChanges });
        });
    };
  } else if (item.insertText) {
    c.apply = item.insertText;
  }
  return c;
}

export function tsCompletionSource(getPath: () => string): CompletionSource {
  return async (ctx) => {
    const path = getPath();
    if (!isTsWorkerPath(path) || !tsClient().ready()) return null;
    // require a word char or explicit trigger, mirroring completeAnyWord etiquette
    const word = ctx.matchBefore(/[\w$.]+$/);
    if (!word && !ctx.explicit) return null;
    const res = await tsClient().getCompletions(path, ctx.pos);
    if (!res || res.items.length === 0) return null;
    const from = word && !word.text.endsWith(".") ? word.from + (word.text.lastIndexOf(".") + 1) : ctx.pos;
    const result: CompletionResult = {
      from: Math.min(from, ctx.pos),
      options: res.items.map((i) => toCompletion(i, path, ctx.pos)),
      validFor: /^[\w$]*$/,
    };
    return result;
  };
}

export function tsLinterExtension(getPath: () => string): Extension {
  return linter(
    async (view) => {
      const path = getPath();
      if (!isTsWorkerPath(path) || !tsClient().ready()) return [];
      const docLen = view.state.doc.length;
      const diags = await tsClient().getDiagnostics(path);
      return diags
        .filter((d) => d.from <= docLen)
        .map((d): Diagnostic => ({ from: d.from, to: Math.min(d.to, docLen), severity: d.severity, message: d.message }));
    },
    { delay: 400 },
  );
}

export function tsHoverExtension(getPath: () => string): Extension {
  return hoverTooltip(async (view, pos) => {
    const path = getPath();
    if (!isTsWorkerPath(path) || !tsClient().ready()) return null;
    const info = await tsClient().getHover(path, pos);
    if (!info) return null;
    return {
      pos,
      create: () => {
        const dom = document.createElement("div");
        dom.className = "cm-ts-hover";
        const sig = document.createElement("div");
        sig.style.fontFamily = "inherit";
        sig.textContent = info.text;
        dom.appendChild(sig);
        if (info.docs) {
          const docs = document.createElement("div");
          docs.style.opacity = "0.75";
          docs.textContent = info.docs;
          dom.appendChild(docs);
        }
        return { dom };
      },
    };
  });
}
