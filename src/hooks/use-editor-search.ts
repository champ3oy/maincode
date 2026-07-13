import { useCallback, useEffect, useRef, useState } from "react";
import {
  findNext,
  findPrevious,
  replaceAll,
  replaceNext,
  SearchQuery,
  setSearchQuery,
} from "@codemirror/search";
import type { EditorView } from "@codemirror/view";

const MATCH_CAP = 1000;
const DEBOUNCE_MS = 120;

interface MatchCount {
  current: number; // 1-based index of current selection, 0 = unknown
  total: number;
  capped: boolean; // true when total was truncated at MATCH_CAP
}

export interface EditorSearchState {
  open: boolean;
  showReplace: boolean;
  query: string;
  replace: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regexp: boolean;
  matchCount: MatchCount;
}

export interface EditorSearchHandlers {
  openFind: (initialQuery?: string) => void;
  openReplace: (initialQuery?: string) => void;
  setQuery: (v: string) => void;
  setReplace: (v: string) => void;
  toggleCase: () => void;
  toggleWord: () => void;
  toggleRegexp: () => void;
  toggleReplace: () => void;
  next: () => void;
  prev: () => void;
  replaceOne: () => void;
  replaceAllMatches: () => void;
  close: () => void;
  /** Call from the EditorView's updateListener to keep the match index current. */
  onEditorUpdate: () => void;
}

export function useEditorSearch(
  viewRef: React.RefObject<EditorView | null>,
): [EditorSearchState, EditorSearchHandlers] {
  const [open, setOpen] = useState(false);
  const [showReplace, setShowReplace] = useState(false);
  const [query, setQueryState] = useState("");
  const [replace, setReplaceState] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regexp, setRegexp] = useState(false);
  const [matchCount, setMatchCount] = useState<MatchCount>({
    current: 0,
    total: 0,
    capped: false,
  });

  // Debounce timer for match-count recomputation.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Stable refs so callbacks don't stale-close over state.
  const stateRef = useRef({ query, caseSensitive, wholeWord, regexp });
  stateRef.current = { query, caseSensitive, wholeWord, regexp };

  // -------------------------------------------------------------------------
  // Build a SearchQuery from current flags.
  // -------------------------------------------------------------------------
  const buildQuery = useCallback(
    (
      search: string,
      cs: boolean,
      ww: boolean,
      re: boolean,
      rep: string,
    ): SearchQuery => {
      // Invalid regexp → fall back to literal search so the editor doesn't crash.
      if (re) {
        try {
          new RegExp(search);
        } catch {
          return new SearchQuery({ search: "", replace: rep });
        }
      }
      return new SearchQuery({
        search,
        caseSensitive: cs,
        wholeWord: ww,
        regexp: re,
        replace: rep,
      });
    },
    [],
  );

  // -------------------------------------------------------------------------
  // Recompute match count (debounced).
  // -------------------------------------------------------------------------
  const scheduleCountRecompute = useCallback(() => {
    if (debounceRef.current !== null) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const view = viewRef.current;
      if (!view) return;
      const { query: q, caseSensitive: cs, wholeWord: ww, regexp: re } = stateRef.current;
      if (!q) {
        setMatchCount({ current: 0, total: 0, capped: false });
        return;
      }
      const sq = buildQuery(q, cs, ww, re, "");
      if (!sq.valid) {
        setMatchCount({ current: 0, total: 0, capped: false });
        return;
      }
      const cursor = sq.getCursor(view.state);
      const sel = view.state.selection.main;
      let total = 0;
      let currentIdx = 0;
      let capped = false;
      let result = cursor.next();
      while (!result.done) {
        total++;
        const { from, to } = result.value;
        if (from === sel.from && to === sel.to) {
          currentIdx = total;
        }
        if (total >= MATCH_CAP) {
          capped = true;
          break;
        }
        result = cursor.next();
      }
      setMatchCount({ current: currentIdx, total, capped });
    }, DEBOUNCE_MS);
  }, [viewRef, buildQuery]);

  // -------------------------------------------------------------------------
  // Dispatch a new SearchQuery to CodeMirror and schedule count recompute.
  // -------------------------------------------------------------------------
  const dispatchQuery = useCallback(
    (
      search: string,
      cs: boolean,
      ww: boolean,
      re: boolean,
      rep: string,
    ) => {
      const view = viewRef.current;
      if (!view) return;
      const sq = buildQuery(search, cs, ww, re, rep);
      view.dispatch({ effects: setSearchQuery.of(sq) });
      scheduleCountRecompute();
    },
    [viewRef, buildQuery, scheduleCountRecompute],
  );

  // Whenever query/flags change, push to CM.
  useEffect(() => {
    if (!open) return;
    dispatchQuery(query, caseSensitive, wholeWord, regexp, replace);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, caseSensitive, wholeWord, regexp, open]);

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------
  const openFind = useCallback((initialQuery?: string) => {
    setOpen(true);
    setShowReplace(false); // ⌘F is find-only; ⌘⌥F opens the replace row
    if (initialQuery !== undefined) setQueryState(initialQuery);
  }, []);

  const openReplace = useCallback((initialQuery?: string) => {
    setOpen(true);
    setShowReplace(true);
    if (initialQuery !== undefined) setQueryState(initialQuery);
  }, []);

  const setQuery = useCallback((v: string) => setQueryState(v), []);
  const setReplace = useCallback((v: string) => setReplaceState(v), []);
  const toggleCase = useCallback(() => setCaseSensitive((b) => !b), []);
  const toggleWord = useCallback(() => setWholeWord((b) => !b), []);
  const toggleRegexp = useCallback(() => setRegexp((b) => !b), []);
  const toggleReplace = useCallback(() => setShowReplace((b) => !b), []);

  const next = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    findNext(view);
    scheduleCountRecompute();
  }, [viewRef, scheduleCountRecompute]);

  const prev = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    findPrevious(view);
    scheduleCountRecompute();
  }, [viewRef, scheduleCountRecompute]);

  const replaceOne = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    // Ensure the replace string is set in the current query before replacing.
    dispatchQuery(
      stateRef.current.query,
      stateRef.current.caseSensitive,
      stateRef.current.wholeWord,
      stateRef.current.regexp,
      replace,
    );
    replaceNext(view);
    scheduleCountRecompute();
  }, [viewRef, replace, dispatchQuery, scheduleCountRecompute]);

  const replaceAllMatches = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    dispatchQuery(
      stateRef.current.query,
      stateRef.current.caseSensitive,
      stateRef.current.wholeWord,
      stateRef.current.regexp,
      replace,
    );
    replaceAll(view);
    scheduleCountRecompute();
  }, [viewRef, replace, dispatchQuery, scheduleCountRecompute]);

  const close = useCallback(() => {
    const view = viewRef.current;
    setOpen(false);
    setMatchCount({ current: 0, total: 0, capped: false });
    if (view) {
      // Clear highlights.
      view.dispatch({
        effects: setSearchQuery.of(new SearchQuery({ search: "" })),
      });
      view.focus();
    }
  }, [viewRef]);

  const onEditorUpdate = useCallback(() => {
    if (!open) return;
    scheduleCountRecompute();
  }, [open, scheduleCountRecompute]);

  // Cleanup debounce on unmount.
  useEffect(() => {
    return () => {
      if (debounceRef.current !== null) clearTimeout(debounceRef.current);
    };
  }, []);

  const state: EditorSearchState = {
    open,
    showReplace,
    query,
    replace,
    caseSensitive,
    wholeWord,
    regexp,
    matchCount,
  };

  const handlers: EditorSearchHandlers = {
    openFind,
    openReplace,
    setQuery,
    setReplace,
    toggleCase,
    toggleWord,
    toggleRegexp,
    toggleReplace,
    next,
    prev,
    replaceOne,
    replaceAllMatches,
    close,
    onEditorUpdate,
  };

  return [state, handlers];
}
