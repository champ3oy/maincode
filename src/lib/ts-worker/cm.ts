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
import { StateEffect, StateField } from "@codemirror/state";
import { isTsWorkerPath } from "./client";
import type { CompletionItemData } from "./protocol";
import { renderHover } from "./hover-render";
import type { IntelligenceClient } from "@/lib/intelligence";

const KIND_MAP: Record<string, string> = {
  var: "variable", let: "variable", const: "variable", "local var": "variable",
  function: "function", "local function": "function", method: "method",
  property: "property", getter: "property", setter: "property",
  class: "class", interface: "interface", enum: "enum", "enum member": "constant",
  module: "namespace", keyword: "keyword", string: "text", alias: "variable",
  type: "type", "type parameter": "type", parameter: "variable",
};

function toCompletion(
  item: CompletionItemData,
  path: string,
  offset: number,
  getClient: () => IntelligenceClient,
): Completion {
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
      void getClient()
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

export function tsCompletionSource(
  getPath: () => string,
  getClient: () => IntelligenceClient,
): CompletionSource {
  return async (ctx) => {
    const path = getPath();
    const client = getClient();
    if (!isTsWorkerPath(path) || !client.ready()) return null;
    // require a word char or explicit trigger, mirroring completeAnyWord etiquette
    const word = ctx.matchBefore(/[\w$.]+$/);
    if (!word && !ctx.explicit) return null;
    const res = await client.getCompletions(path, ctx.pos);
    if (!res || res.items.length === 0) return null;
    const from = word && !word.text.endsWith(".") ? word.from + (word.text.lastIndexOf(".") + 1) : ctx.pos;
    const result: CompletionResult = {
      from: Math.min(from, ctx.pos),
      options: res.items.map((i) => toCompletion(i, path, ctx.pos, getClient)),
      validFor: /^[\w$]*$/,
    };
    return result;
  };
}

export function tsLinterExtension(
  getPath: () => string,
  getClient: () => IntelligenceClient,
): Extension {
  return linter(
    async (view) => {
      const client = getClient();
      const path = getPath();
      if (!isTsWorkerPath(path) || !client.ready()) return [];
      const docLen = view.state.doc.length;
      const diags = await client.getDiagnostics(path);
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
  ".cm-cmd-hover-active .cm-content": { cursor: "pointer" },
});

// A StateEffect carries the word range to underline (or null to clear). The
// StateField renders it. Driving the decoration through the normal
// transaction/state cycle — rather than mutating a ViewPlugin field and forcing
// a re-read with an empty dispatch — avoids the re-entrant-dispatch trap: a
// ViewPlugin method named `update` IS the update lifecycle hook, so dispatching
// from it is forbidden by CodeMirror and silently breaks the plugin.
const setCmdHover = StateEffect.define<{ from: number; to: number } | null>();

const cmdHoverField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setCmdHover)) {
        deco = e.value
          ? Decoration.set([cmdHoverMark.range(e.value.from, e.value.to)])
          : Decoration.none;
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export function tsGoToDefHoverAffordance(
  getPath: () => string,
  enabled: () => boolean,
): Extension {
  const active = (): boolean => enabled() && isTsWorkerPath(getPath());

  const plugin = ViewPlugin.fromClass(
    class {
      // The currently underlined word range, so we skip redundant dispatches
      // while the pointer moves within the same identifier.
      private from = -1;
      private to = -1;
      private lastX = -1;
      private lastY = -1;

      constructor(readonly view: EditorView) {}

      /** Recompute the target word from the current modifier + mouse position
       *  and dispatch a change only when the underlined range actually moves. */
      private refresh(meta: boolean) {
        let next: { from: number; to: number } | null = null;
        if (meta && active() && this.lastX >= 0) {
          const pos = this.view.posAtCoords({ x: this.lastX, y: this.lastY });
          if (pos != null) {
            const word = this.view.state.wordAt(pos);
            if (word && word.from !== word.to) next = { from: word.from, to: word.to };
          }
        }
        const nf = next ? next.from : -1;
        const nt = next ? next.to : -1;
        if (nf === this.from && nt === this.to) return; // unchanged — no-op
        this.from = nf;
        this.to = nt;
        if (next) this.view.scrollDOM.classList.add("cm-cmd-hover-active");
        else this.view.scrollDOM.classList.remove("cm-cmd-hover-active");
        // Dispatched from a DOM event handler (never from update()), so this is
        // a normal, safe transaction.
        this.view.dispatch({ effects: setCmdHover.of(next) });
      }

      onMouseMove(e: MouseEvent) {
        this.lastX = e.clientX;
        this.lastY = e.clientY;
        this.refresh(e.metaKey || e.ctrlKey);
      }
      onKey(e: KeyboardEvent) {
        this.refresh(e.metaKey || e.ctrlKey);
      }
      onLeave() {
        this.lastX = -1;
        this.lastY = -1;
        this.refresh(false);
      }

      destroy() {
        this.view.scrollDOM.classList.remove("cm-cmd-hover-active");
      }
    },
    {
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

  return [cmdHoverField, plugin, cmdHoverTheme];
}

export function tsHoverExtension(
  getPath: () => string,
  getClient: () => IntelligenceClient,
): Extension {
  return hoverTooltip(async (view, pos) => {
    const path = getPath();
    const client = getClient();
    if (!isTsWorkerPath(path) || !client.ready()) return null;
    const info = await client.getHover(path, pos);
    if (!info) return null;
    return {
      pos,
      create: () => ({ dom: renderHover(info) }),
    };
  });
}
