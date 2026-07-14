import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { Compartment, EditorState, EditorSelection, Prec } from "@codemirror/state";
import { EditorView, keymap, tooltips } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { indentUnit } from "@codemirror/language";
import { search } from "@codemirror/search";
import { useTheme } from "next-themes";
import { cmLanguageFor } from "@/lib/cm-language";
import { baseSetup, completionExtensions, lintExtensions } from "@/lib/cm-setup";
import { pierreDark, searchMatchTheme, tooltipTheme } from "@/lib/cm-theme";
import { languageKeyForPath } from "@/lib/language";
import { useSettings, FONT_STACKS } from "@/hooks/use-settings";
import { useEditorSearch } from "@/hooks/use-editor-search";
import { formatWithCursorInView, resolvePrettierConfig } from "@/lib/format";
import {
  tsCompletionSource,
  tsLinterExtension,
  tsHoverExtension,
  tsGoToDefHoverAffordance,
} from "@/lib/ts-worker/cm";
import { scriptKindForPath } from "@/lib/ts-worker/mapping";
import type { DefinitionResult } from "@/lib/ts-worker/protocol";
import { clientForPath } from "@/lib/intelligence";
import { FindWidget } from "./find-widget";

// Constrain tooltip positioning (lint messages, TS hover, autocomplete) to the
// editor's own box instead of the whole browser window (CodeMirror's default).
// The lint package always requests its diagnostic tooltip `above` the line. With
// the window as the reference, the positioner sees room above a diagnostic on
// the first visible lines — all the way to the window top — so it renders the
// tooltip up there, behind the tab bar / header chrome sitting above the editor,
// and it gets clipped (the reported bug). Bounding the space to the editor rect
// raises the "top" to the editor's own top edge, so the positioner flips the
// tooltip *below* the line when there's no room above — matching the TS hover.
const editorTooltipSpace = tooltips({
  tooltipSpace: (view) => view.dom.getBoundingClientRect(),
});

// In light mode, keep CodeMirror's default highlighting but make the surface
// transparent so it blends with the app background.
const lightBackground = EditorView.theme({
  "&": { backgroundColor: "transparent" },
  ".cm-gutters": { backgroundColor: "transparent", border: "none" },
  ".cm-activeLineGutter": { backgroundColor: "transparent" },
});

function themeExtensions(dark: boolean) {
  // Dark mode uses the pierre-dark palette so the editor matches the diff view.
  return dark ? pierreDark() : [lightBackground];
}

// Editor font size + family live on the `.cm-editor` root so they cascade to
// content and gutters. Reconfigured live via a Compartment when either changes.
function fontTheme(size: number, family: string) {
  return EditorView.theme({
    "&": { fontSize: `${size}px` },
    ".cm-scroller": { fontFamily: family },
  });
}

interface CodeEditorProps {
  path: string;
  /** Document text used when this path has no cached editor state yet. */
  content: string;
  onChange: (path: string, content: string) => void;
  onSave: (path: string) => void;
  onCursor?: (line: number, col: number) => void;
  /** Optional project root used to resolve .prettierrc config. */
  formatRoot?: string | null;
  /**
   * Registers a view-level formatter so menu/palette/format-on-save paths can
   * format through the live editor (visible change, cursor preserved, undo).
   * The fn returns the formatted text, or null when it can't handle the path
   * (not the active document, or no parser).
   */
  onRegisterFormatter?: (
    fn: (path: string, config: object) => Promise<string | null>,
  ) => void;
  /**
   * Cmd/Ctrl+Click go-to-definition. Called with the resolved TS definition
   * target so the app can open the file and reveal the location. Only wired when
   * the TS worker is enabled (see `typescript` gate). If omitted, Cmd+Click is
   * a no-op and normal text interaction is preserved.
   */
  onGoToDefinition?: (target: DefinitionResult) => void;
  /**
   * When set and it matches the active path, the editor scrolls to and selects
   * the start of `line` (1-based) exactly once, then calls `onRevealConsumed`.
   * Drives cross-file go-to-definition: App sets this after openFile so the
   * newly-mounted (or already-mounted) editor jumps to the target line.
   */
  revealTarget?: { path: string; line: number; column: number } | null;
  onRevealConsumed?: () => void;
}

export function CodeEditor({
  path,
  content,
  onChange,
  onSave,
  onCursor,
  formatRoot,
  onRegisterFormatter,
  onGoToDefinition,
  revealTarget,
  onRevealConsumed,
}: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const statesRef = useRef(new Map<string, EditorState>());
  const pathRef = useRef(path);
  const formatRootRef = useRef(formatRoot ?? null);
  formatRootRef.current = formatRoot ?? null;
  const themeCompartment = useRef(new Compartment());
  const langCompartment = useRef(new Compartment());
  const { resolvedTheme } = useTheme();
  const { settings } = useSettings();
  const { fontSize, fontFamily: fontFamilyChoice, tabSize, wordWrap, autocomplete, linting, typescript } = settings.editor;
  const fontFamily = FONT_STACKS[fontFamilyChoice];

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const onCursorRef = useRef(onCursor);
  onCursorRef.current = onCursor;
  const darkRef = useRef(resolvedTheme === "dark");
  darkRef.current = resolvedTheme === "dark";

  const fontSizeRef = useRef(fontSize);
  fontSizeRef.current = fontSize;
  const fontFamilyRef = useRef(fontFamily);
  fontFamilyRef.current = fontFamily;
  const fontCompartment = useRef(new Compartment());

  const tabSizeRef = useRef(tabSize);
  tabSizeRef.current = tabSize;
  const tabCompartment = useRef(new Compartment());

  const wordWrapRef = useRef(wordWrap);
  wordWrapRef.current = wordWrap;
  const wrapCompartment = useRef(new Compartment());

  // Autocomplete + lint compartments and refs.
  const autocompleteRef = useRef(autocomplete);
  autocompleteRef.current = autocomplete;
  const completionCompartment = useRef(new Compartment());

  const lintingRef = useRef(linting);
  lintingRef.current = linting;
  const lintCompartment = useRef(new Compartment());

  const typescriptRef = useRef(typescript);
  typescriptRef.current = typescript;

  // Stable getter so extension closures resolve the routed intelligence client
  // lazily (returns null when the active path's language has no LSP server).
  const getClient = useRef(() => clientForPath(pathRef.current));

  const onGoToDefinitionRef = useRef(onGoToDefinition);
  onGoToDefinitionRef.current = onGoToDefinition;
  const onRevealConsumedRef = useRef(onRevealConsumed);
  onRevealConsumedRef.current = onRevealConsumed;

  // TS completion source — built once; self-gates on getClient() returning a
  // non-null, ready() client (null when the active path has no LSP server).
  // The lint/hover extensions are built fresh per lint-compartment build (see
  // buildLintExtensions) so a reconfigure installs a new linter() that re-runs.
  const tsExtensions = useRef({
    source: tsCompletionSource(() => pathRef.current, getClient.current),
  });

  /** Returns "ts" for .ts/.tsx/.mts/.cts, "js" for everything else with a TS worker path. */
  function tsKindForPath(p: string): "ts" | "js" {
    const k = scriptKindForPath(p);
    return k === "ts" || k === "tsx" ? "ts" : "js";
  }

  // Single source of truth for the lint compartment's contents. Both makeState
  // and the live-reconfigure paths (settings effect, onTypesUpdated) build
  // identical config through here so a compartment reconfigure never diverges
  // from the initial state. `linting`/`typescript` are passed explicitly so
  // effects can hand in the reactive values while makeState hands in the refs.
  const buildLintExtensions = useRef(
    (docPath: string, lintingEnabled: boolean, tsEnabled: boolean) =>
      lintExtensions(
        lintingEnabled,
        languageKeyForPath(docPath),
        tsEnabled
          ? {
              // Fresh linter/hover instances per build: reconfiguring the lint
              // compartment with a brand-new linter() forces CodeMirror to tear
              // down the idle lint plugin and run a fresh lint. Reusing the same
              // instances would not — see lint-refresh.test.ts.
              linter: tsLinterExtension(() => pathRef.current, getClient.current),
              hover: tsHoverExtension(() => pathRef.current, getClient.current),
              kind: tsKindForPath(docPath),
            }
          : undefined,
      ),
  );

  // Search state + handlers from the hook.
  const [searchState, searchHandlers] = useEditorSearch(viewRef);

  // Stable ref so the keymap closure can call the latest handlers without
  // capturing a stale version.
  const searchHandlersRef = useRef(searchHandlers);
  searchHandlersRef.current = searchHandlers;

  const makeStateRef = useRef((docPath: string, doc: string): EditorState => {
    return EditorState.create({
      doc,
      extensions: [
        // Override Mod-f / Mod-Alt-f BEFORE baseSetup so our handler wins and
        // CodeMirror's built-in docked panel never opens.
        Prec.highest(
          keymap.of([
            {
              key: "Mod-f",
              run: (view) => {
                const sel = view.state.sliceDoc(
                  view.state.selection.main.from,
                  view.state.selection.main.to,
                );
                searchHandlersRef.current.openFind(sel || undefined);
                return true;
              },
            },
            {
              key: "Mod-Alt-f",
              run: (view) => {
                const sel = view.state.sliceDoc(
                  view.state.selection.main.from,
                  view.state.selection.main.to,
                );
                searchHandlersRef.current.openReplace(sel || undefined);
                return true;
              },
            },
          ]),
        ),
        baseSetup,
        // Required: initialises the search state so setSearchQuery has effect.
        search({ top: true }),
        searchMatchTheme,
        tooltipTheme,
        editorTooltipSpace,
        keymap.of([
          {
            key: "Mod-s",
            run: () => {
              onSaveRef.current(pathRef.current);
              return true;
            },
          },
          {
            key: "Alt-Shift-f",
            run: (view) => {
              void (async () => {
                const config = await resolvePrettierConfig(formatRootRef.current).catch(() => ({}));
                try {
                  const formatted = await formatWithCursorInView(
                    view,
                    pathRef.current,
                    config,
                  );
                  if (formatted === null) {
                    toast.info("No formatter for this file type");
                  }
                } catch (err) {
                  toast.error(
                    `Format failed: ${err instanceof Error ? err.message : String(err)}`,
                  );
                }
              })();
              return true;
            },
          },
          indentWithTab,
        ]),
        langCompartment.current.of(
          cmLanguageFor(languageKeyForPath(docPath)),
        ),
        themeCompartment.current.of(themeExtensions(darkRef.current)),
        fontCompartment.current.of(fontTheme(fontSizeRef.current, fontFamilyRef.current)),
        tabCompartment.current.of([
          EditorState.tabSize.of(tabSizeRef.current),
          indentUnit.of(" ".repeat(tabSizeRef.current)),
        ]),
        wrapCompartment.current.of(wordWrapRef.current ? EditorView.lineWrapping : []),
        completionCompartment.current.of(
          completionExtensions(
            autocompleteRef.current,
            typescriptRef.current ? { source: tsExtensions.current.source } : undefined,
          ),
        ),
        lintCompartment.current.of(
          buildLintExtensions.current(docPath, lintingRef.current, typescriptRef.current),
        ),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const docString = update.state.doc.toString();
            onChangeRef.current(pathRef.current, docString);
            // Notify the routed intelligence client (if any) of the doc change
            // so completions/diagnostics stay fresh.
            getClient.current()?.notifyDocChanged(pathRef.current, docString);
            // Keep match count fresh when the document changes.
            searchHandlersRef.current.onEditorUpdate();
          }
          if (update.selectionSet || update.docChanged) {
            const head = update.state.selection.main.head;
            const line = update.state.doc.lineAt(head);
            onCursorRef.current?.(line.number, head - line.from + 1);
            // Keep current-match index in sync when the cursor moves.
            if (update.selectionSet) {
              searchHandlersRef.current.onEditorUpdate();
            }
          }
        }),
        // Cmd/Ctrl+Click go-to-definition. Gated on the TS worker being on
        // (typescriptRef) and the active file being a TS-worker path; otherwise we
        // leave the event alone so normal click/selection behaves as usual. When we
        // do handle it we preventDefault so the browser doesn't also place the caret
        // / start a text selection at the click point.
        EditorView.domEventHandlers({
          mousedown: (event, view) => {
            if (!(event.metaKey || event.ctrlKey)) return false;
            const goto = onGoToDefinitionRef.current;
            if (!goto || !typescriptRef.current) return false;
            const p = pathRef.current;
            const client = getClient.current();
            if (!client || !client.ready()) return false;
            const offset = view.posAtCoords({ x: event.clientX, y: event.clientY });
            if (offset == null) return false;
            event.preventDefault();
            void client
              .getDefinition(p, offset)
              .then((target) => {
                if (target) goto(target);
              });
            return true;
          },
        }),
        // Cmd/Ctrl-hover affordance: underlines the hovered identifier + shows a
        // pointer while the modifier is held, so Cmd+Click go-to-def is
        // discoverable. Self-gates on typescript + isTsWorkerPath; purely visual,
        // never preventDefaults, so it never interferes with the mousedown
        // handler above or normal selection.
        tsGoToDefHoverAffordance(
          () => pathRef.current,
          () => typescriptRef.current,
        ),
      ],
    });
  });

  // Create the single persistent view.
  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({
      state: makeStateRef.current(pathRef.current, content),
      parent: hostRef.current,
    });
    viewRef.current = view;
    view.focus();
    // Tell the routed intelligence client (if any) this document is now open.
    const client = getClient.current();
    if (client?.ready()) client.notifyDocOpened(pathRef.current, content);
    return () => {
      view.destroy();
      viewRef.current = null;
      // Best-effort: tell the engine the document is no longer visible.
      // (Worker's notifyDocClosed is a no-op today; LSP tolerates open docs.)
      getClient.current()?.notifyDocClosed(pathRef.current);
    };
    // The initial doc is only read once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Register the view-level formatter so use-editor's formatFile / save-time
  // formatting go through the live view (a state-only edit never reaches the
  // uncontrolled EditorView — the buffer wouldn't visibly change).
  const onRegisterFormatterRef = useRef(onRegisterFormatter);
  onRegisterFormatterRef.current = onRegisterFormatter;
  useEffect(() => {
    onRegisterFormatterRef.current?.(async (docPath, config) => {
      const view = viewRef.current;
      if (!view || docPath !== pathRef.current) return null;
      return formatWithCursorInView(view, docPath, config);
    });
  }, []);

  // Swap editor state when the active path changes, caching the old one so
  // undo history survives tab switches.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || pathRef.current === path) return;
    statesRef.current.set(pathRef.current, view.state);
    // The previous path is no longer the visible document — best-effort
    // didClose (worker: no-op; LSP: tolerant of docs left open, but this
    // keeps the signal accurate for engines that care). Routed by the OLD
    // path, since getClient reads pathRef.current.
    getClient.current()?.notifyDocClosed(pathRef.current);
    pathRef.current = path;
    const cached = statesRef.current.get(path);
    view.setState(cached ?? makeStateRef.current(path, content));
    view.focus();
    // Routed by the NEW path (pathRef.current was just updated above).
    const c = getClient.current();
    if (c?.ready()) c.notifyDocOpened(path, content);
  }, [path, content]);

  // Keep the theme in sync (also re-applied after state swaps, which may
  // restore a cached state configured under the old theme).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: themeCompartment.current.reconfigure(
        themeExtensions(resolvedTheme === "dark"),
      ),
    });
  }, [resolvedTheme, path]);

  // Apply the editor font size + family live, and re-apply after tab swaps (a
  // cached state carries the font compartment value from when it was created).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: fontCompartment.current.reconfigure(fontTheme(fontSize, fontFamily)),
    });
  }, [fontSize, fontFamily, path]);

  // Apply tab size + indent unit live.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: tabCompartment.current.reconfigure([
        EditorState.tabSize.of(tabSize),
        indentUnit.of(" ".repeat(tabSize)),
      ]),
    });
  }, [tabSize, path]);

  // Apply word wrap live.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: wrapCompartment.current.reconfigure(
        wordWrap ? EditorView.lineWrapping : [],
      ),
    });
  }, [wordWrap, path]);

  // Apply autocomplete live; path dep ensures JSON-specific linter is correct
  // after tab swaps (lint compartment depends on languageKey for JSON linter).
  // typescript dep ensures TS sources are added/removed when the toggle changes.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: completionCompartment.current.reconfigure(
        completionExtensions(
          autocomplete,
          typescript ? { source: tsExtensions.current.source } : undefined,
        ),
      ),
    });
  }, [autocomplete, typescript, path]);

  // Apply linting live; path dep recomputes languageKey so JSON docs get the
  // JSON linter after tab swaps. typescript dep gates TS diagnostic sources.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: lintCompartment.current.reconfigure(
        buildLintExtensions.current(path, linting, typescript),
      ),
    });
  }, [linting, typescript, path]);

  // When the TS worker loads new types (e.g., node_modules/@types), re-run the
  // linter so diagnostics reflect the updated type info.
  //
  // We RECONFIGURE the lint compartment with a freshly-built lint extension
  // rather than calling forceLinting(view). forceLinting is a no-op once the
  // editor is idle: CodeMirror's lint plugin only forces a run when a lint is
  // already scheduled (`this.set === true`), and after the initial lint applies
  // with no subsequent doc change nothing re-schedules one. So the stale
  // "Cannot find module" errors on the first-opened file never cleared until a
  // tab switch rebuilt the state. Installing a NEW linter() instance tears down
  // the idle lint plugin and runs a fresh lint against the converged (clean)
  // diagnostics. Proven in lint-refresh.test.ts.
  //
  // Warm-up fires many `typesUpdated` events (one per resolution round); debounce
  // so the burst collapses into ONE reconfigure after types settle.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = getClient.current()?.onTypesUpdated(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const view = viewRef.current;
        if (!view) return;
        view.dispatch({
          effects: lintCompartment.current.reconfigure(
            buildLintExtensions.current(
              pathRef.current,
              lintingRef.current,
              typescriptRef.current,
            ),
          ),
        });
      }, 300);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsub?.();
    };
  }, []);

  // Go-to-definition reveal: when App sets `revealTarget` for the ACTIVE path
  // (after openFile), scroll to and select the start of the target line ONCE,
  // then clear it via onRevealConsumed. The `path` dep ensures this runs after a
  // cross-file swap has mounted the target document's state (pathRef === path by
  // then). Same-file jumps also land here since the effect re-fires on the new
  // revealTarget. We select the line start (column is available but line-level
  // placement is the robust, expected behavior for go-to-definition).
  useEffect(() => {
    if (!revealTarget || revealTarget.path !== path) return;
    const view = viewRef.current;
    if (!view) return;
    const doc = view.state.doc;
    if (revealTarget.line < 1 || revealTarget.line > doc.lines) {
      onRevealConsumedRef.current?.();
      return;
    }
    const lineInfo = doc.line(revealTarget.line);
    const col = Math.max(1, revealTarget.column);
    const pos = Math.min(lineInfo.from + (col - 1), lineInfo.to);
    view.dispatch({
      selection: EditorSelection.cursor(pos),
      effects: EditorView.scrollIntoView(pos, { y: "center" }),
      scrollIntoView: true,
    });
    view.focus();
    onRevealConsumedRef.current?.();
  }, [revealTarget, path]);

  return (
    <div className="relative h-full min-h-0 overflow-hidden bg-background">
      <div ref={hostRef} className="h-full min-h-0 overflow-hidden" />
      <FindWidget
        open={searchState.open}
        showReplace={searchState.showReplace}
        query={searchState.query}
        replace={searchState.replace}
        caseSensitive={searchState.caseSensitive}
        wholeWord={searchState.wholeWord}
        regexp={searchState.regexp}
        matchCurrent={searchState.matchCount.current}
        matchTotal={searchState.matchCount.total}
        matchCapped={searchState.matchCount.capped}
        setQuery={searchHandlers.setQuery}
        setReplace={searchHandlers.setReplace}
        toggleCase={searchHandlers.toggleCase}
        toggleWord={searchHandlers.toggleWord}
        toggleRegexp={searchHandlers.toggleRegexp}
        toggleReplace={searchHandlers.toggleReplace}
        next={searchHandlers.next}
        prev={searchHandlers.prev}
        replaceOne={searchHandlers.replaceOne}
        replaceAllMatches={searchHandlers.replaceAllMatches}
        close={searchHandlers.close}
      />
    </div>
  );
}
