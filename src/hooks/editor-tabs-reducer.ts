export interface EditorTab {
  path: string;
  name: string;
  content: string;
  savedContent: string;
}

export interface TabsState {
  tabs: EditorTab[];
  activePath: string | null;
}

export type TabsAction =
  | { type: "open"; path: string; name: string; content: string }
  | { type: "activate"; path: string }
  | { type: "edit"; path: string; content: string }
  | { type: "markSaved"; path: string }
  | { type: "close"; path: string }
  | { type: "renamePath"; from: string; to: string; name: string }
  | { type: "reset" };

export const initialTabsState: TabsState = { tabs: [], activePath: null };

export function isDirty(tab: EditorTab): boolean {
  return tab.content !== tab.savedContent;
}

export function tabsReducer(state: TabsState, action: TabsAction): TabsState {
  switch (action.type) {
    case "open": {
      if (state.tabs.some((t) => t.path === action.path)) {
        return { ...state, activePath: action.path };
      }
      const tab: EditorTab = {
        path: action.path,
        name: action.name,
        content: action.content,
        savedContent: action.content,
      };
      return { tabs: [...state.tabs, tab], activePath: action.path };
    }
    case "activate":
      if (!state.tabs.some((t) => t.path === action.path)) return state;
      return { ...state, activePath: action.path };
    case "edit":
      return {
        ...state,
        tabs: state.tabs.map((t) =>
          t.path === action.path ? { ...t, content: action.content } : t,
        ),
      };
    case "markSaved":
      return {
        ...state,
        tabs: state.tabs.map((t) =>
          t.path === action.path ? { ...t, savedContent: t.content } : t,
        ),
      };
    case "close": {
      const idx = state.tabs.findIndex((t) => t.path === action.path);
      if (idx === -1) return state;
      const tabs = state.tabs.filter((t) => t.path !== action.path);
      let activePath = state.activePath;
      if (state.activePath === action.path) {
        const next = tabs[Math.min(idx, tabs.length - 1)];
        activePath = next ? next.path : null;
      }
      return { tabs, activePath };
    }
    case "renamePath": {
      const tabs = state.tabs.map((t) =>
        t.path === action.from
          ? { ...t, path: action.to, name: action.name }
          : t,
      );
      const activePath =
        state.activePath === action.from ? action.to : state.activePath;
      return { tabs, activePath };
    }
    case "reset":
      return initialTabsState;
  }
}
