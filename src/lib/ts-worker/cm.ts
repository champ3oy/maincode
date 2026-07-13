import { type Completion, type CompletionResult, type CompletionSource } from "@codemirror/autocomplete";
import { linter, type Diagnostic } from "@codemirror/lint";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  hoverTooltip,
  type Extension,
} from "@codemirror/view";
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
      // Build the change set first so we can use it for position mapping later.
      const labelChange = view.state.changes({ from, to, insert: item.insertText ?? item.label });
      view.dispatch({ changes: labelChange });
      const docAfterLabel = view.state.doc;
      // Safe despite the ~200ms doc-sync debounce: v1 import edits are same-file
      // and land at the top of the file (independent of the cursor); the
      // docAfterLabel identity check drops the edits if ANY change landed since,
      // and mapPos re-bases them through the label insertion. Do not "fix" this
      // into a stale-doc query.
      void tsClient()
        .getCompletionDetails(path, offset, item)
        .then((details) => {
          if (!details || details.extraChanges.length === 0) return;
          // If the user typed between accepting the completion and the worker
          // responding, the doc has moved on. Drop the import edits rather than
          // applying stale offsets that could corrupt the document.
          if (view.state.doc !== docAfterLabel) return;
          // Map each extraChange through the label insertion so the positions
          // stay valid relative to the document after the label was inserted.
          const mapped = details.extraChanges.map((c) => ({
            from: labelChange.mapPos(c.from, 1),
            to: labelChange.mapPos(c.to, 1),
            insert: c.insert,
          }));
          view.dispatch({ changes: mapped });
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
    { delay: 250 },
  );
}

/**
 * VS Code-style Cmd/Ctrl-hover affordance for go-to-definition. While the user
 * holds Cmd (metaKey; Ctrl on non-mac) and hovers an identifier in a TS/JS file,
 * the hovered word is underlined and the cursor becomes a pointer — signalling
 * it's clickable (the existing Cmd+Click mousedown handler does the navigation).
 *
 * Self-gates on the caller's `enabled()` (settings.editor.typescript) plus
 * `isTsWorkerPath(path)`. It only ever adds a passive mark decoration + cursor
 * style; it never calls preventDefault or dispatches selection changes, so it
 * cannot interfere with Cmd+Click go-to-def or with normal text selection when
 * Cmd isn't held.
 */
const cmdHoverMark = Decoration.mark({
  class: "cm-cmd-hover-link",
  attributes: { style: "text-decoration: underline; cursor: pointer;" },
});

const cmdHoverTheme = EditorView.theme({
  ".cm-cmd-hover-active .cm-scroller": { cursor: "pointer" },
});

export function tsGoToDefHoverAffordance(
  getPath: () => string,
  enabled: () => boolean,
): Extension {
  const active = (): boolean => enabled() && isTsWorkerPath(getPath());

  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none;
      // Whether the meta/ctrl modifier is currently held.
      private meta = false;
      // Last known mouse coordinates, so a keydown (with no fresh mouse event)
      // can still resolve the word currently under the pointer.
      private lastX = -1;
      private lastY = -1;

      constructor(readonly view: EditorView) {}

      /** Recompute the underlined word from the current meta state + mouse pos. */
      update() {
        if (!this.meta || !active() || this.lastX < 0) {
          this.setDeco(Decoration.none);
          return;
        }
        const pos = this.view.posAtCoords({ x: this.lastX, y: this.lastY });
        if (pos == null) {
          this.setDeco(Decoration.none);
          return;
        }
        const word = this.view.state.wordAt(pos);
        if (!word || word.from === word.to) {
          this.setDeco(Decoration.none);
          return;
        }
        this.setDeco(Decoration.set([cmdHoverMark.range(word.from, word.to)]));
      }

      // The from/to of the currently marked word, so we can skip redundant
      // dispatches while the pointer moves within the same identifier.
      private markedFrom = -1;
      private markedTo = -1;

      private setDeco(deco: DecorationSet) {
        let from = -1;
        let to = -1;
        if (deco !== Decoration.none) {
          const it = deco.iter();
          from = it.from;
          to = it.to;
        }
        // No change (same word range, or still nothing) → nothing to do. This
        // keeps mousemove from dispatching a transaction on every pixel.
        if (from === this.markedFrom && to === this.markedTo) return;
        this.markedFrom = from;
        this.markedTo = to;
        this.decorations = deco;
        if (deco !== Decoration.none) this.view.scrollDOM.classList.add("cm-cmd-hover-active");
        else this.view.scrollDOM.classList.remove("cm-cmd-hover-active");
        // Empty transaction: forces the view to re-read `decorations`.
        this.view.dispatch({});
      }

      onMouseMove(e: MouseEvent) {
        this.lastX = e.clientX;
        this.lastY = e.clientY;
        this.meta = e.metaKey || e.ctrlKey;
        this.update();
      }
      onKey(e: KeyboardEvent) {
        this.meta = e.metaKey || e.ctrlKey;
        this.update();
      }
      onLeave() {
        this.meta = false;
        this.lastX = -1;
        this.lastY = -1;
        this.setDeco(Decoration.none);
      }

      destroy() {
        this.view.scrollDOM.classList.remove("cm-cmd-hover-active");
      }
    },
    {
      decorations: (v) => v.decorations,
      eventHandlers: {
        mousemove(e) {
          this.onMouseMove(e);
        },
        mouseleave() {
          this.onLeave();
        },
        keydown(e) {
          this.onKey(e);
        },
        keyup(e) {
          this.onKey(e);
        },
      },
    },
  );

  return [plugin, cmdHoverTheme];
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
