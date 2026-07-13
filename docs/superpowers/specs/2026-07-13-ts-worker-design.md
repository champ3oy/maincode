# TypeScript Worker — Design

**Goal:** Semantic JS/TS intelligence — module-aware completions with
auto-import (`useState` completes before it's in the file), `obj.` member
completions, real TS diagnostics, and hover type info — via the TypeScript
compiler running in a web worker. No external servers; works offline against
the project's own `node_modules`.

## Architecture

One dedicated web worker (Vite `?worker` import, like the diff worker) hosting
a single `ts.createLanguageService` over an **in-memory VFS**. CodeMirror talks
to it through async sources; the worker reaches the filesystem through a
main-thread proxy (workers cannot call Tauri `invoke`).

```
CodeMirror (per editor)             main thread                worker
  completion source ──┐                                   ┌ LanguageService
  lint source ────────┼── request/response (postMessage) ─┤ in-memory VFS
  hover tooltip ──────┘                                   └ module resolver
                            ▲                                   │
                            └── fs proxy: invoke(read_file,     │ "need
                                list_files_recursive) ◄─────────┘  node_modules/react/…"
```

- **Protocol:** request/response messages with ids
  (`{id, kind: "completions"|"diagnostics"|"hover"|"completionDetails", …}`),
  plus notifications (`docChanged`, `projectOpened`, `needFiles`/`filesLoaded`).
  A tiny promise-based RPC wrapper on both sides.
- **Lifecycle:** the worker starts lazily — on the first JS/TS file opened in a
  project. One project (root) at a time; `closeFolder`/new root resets it.

## VFS strategy (TS host is synchronous; IPC is not)

1. **Preload on project open:**
   - TS default libs (`typescript/lib/lib.*.d.ts`) bundled as lazy raw assets
     into the worker chunk's chunk group.
   - Project sources: `list_files_recursive` (already skips `node_modules`,
     `.git`, `dist`, …) filtered to `ts tsx js jsx mjs cjs json`, capped at
     **2,000 files**; contents via `read_file` (2 MB cap each). Files that fail
     to read are skipped.
   - `tsconfig.json` / `jsconfig.json` (compilerOptions honored where possible;
     fall back to sensible defaults: `jsx: react-jsx`, `module/target: esnext`,
     `moduleResolution: bundler`, `allowJs: true`, `strict` from tsconfig).
2. **On-demand `node_modules`:** the host's resolution callbacks record misses
   (e.g. `react`). The worker requests that package's `package.json`, its
   `types`/`typings` entry, `@types/<pkg>` equivalents, and referenced `.d.ts`
   files from the main thread, inserts them into the VFS, bumps the project
   version, and notifies the frontend to **re-query** (diagnostics refresh,
   and the completion source retries). First query against a new module may
   lag; results are cached for the session.
3. **Edits:** the frontend streams open-file contents (debounced ~200 ms,
   versioned) via `docChanged`. Saves of other files update the VFS on the
   watcher's `repo:changed` only for changed paths (best-effort; full
   correctness deferred).

## Features (v1)

For `.ts .tsx .js .jsx .mjs .cjs` files when a project folder is open:

- **Completions** (CodeMirror async source, replacing `completeAnyWord` for
  these files once the worker is ready; word-completions remain the fallback
  while warming up):
  - member completions after `.` / optional chaining,
  - import-clause completions (`import { useSta… } from "react"`),
  - **module-export suggestions with auto-import**: enabled via
    `includeCompletionsForModuleExports`; accepting one applies the completion
    AND the import edit from `getCompletionEntryDetails` (`codeActions`) in a
    single dispatched transaction. Entries show their source module in the
    completion detail.
- **Diagnostics:** `getSyntacticDiagnostics` + `getSemanticDiagnostics` for the
  active file, mapped to CodeMirror `Diagnostic`s (severity from TS category).
  For TS/TSX these REPLACE the Lezer syntax linter; JS files keep the Lezer
  syntax linter unless `checkJs` is enabled in the project config. The JSON
  parse linter is unchanged.
- **Hover:** `getQuickInfoAtPosition` rendered in a CodeMirror `hoverTooltip`
  (display string + docs first line), styled by the existing `tooltipTheme`.

## Integration points

- `src/lib/ts-worker/protocol.ts` — message types + promise RPC helper.
- `src/lib/ts-worker/worker.ts` — the worker: VFS, LanguageServiceHost,
  resolution-miss tracking, request handlers. `typescript` is imported ONLY
  here (worker chunk; main bundle unchanged).
- `src/lib/ts-worker/client.ts` — main-thread singleton: starts the worker,
  serves its fs requests via `@/lib/fs`, exposes
  `getCompletions/getDiagnostics/getHover/notifyDocChanged/openProject`.
- `src/lib/cm-setup.ts` — the JS/TS completion source and linter plug into the
  existing `completionExtensions`/`lintExtensions` (new optional args), gated
  by the same `editor.autocomplete` / `editor.linting` settings. Hover is a new
  small extension applied for JS/TS docs.
- `code-editor.tsx` — passes the path/language into the sources (already has
  compartments + `languageKeyForPath`); streams doc changes to the client.
- `App.tsx` — `openProject(rootPath)` on workspace open/close.

## Performance guardrails

- Preload caps: 2,000 project files, 2 MB/file; skipped-over counts logged.
- Debounce: doc sync ~200 ms; diagnostics run per doc version (stale results
  dropped); completions request at most one in flight per editor.
- Auto-import completions capped (TS `includeCompletionsForModuleExports`
  bounded by loaded modules — only resolved packages contribute).
- The worker is one instance; if it crashes it restarts lazily on next query;
  editor degrades gracefully to the lightweight sources (never blocks typing).

## Settings

Reuses `editor.autocomplete` and `editor.linting`. One new setting:
`editor.typescript` ("TypeScript intelligence", default **true**) to turn the
worker off entirely (Settings → Editor toggle; Rust default + store + merge
test + settings row).

## Out of scope (v1)

Go-to-definition, rename, find-references, signature help, multi-root
workspaces, `.vue`/`.svelte`, project references, watching `node_modules` for
changes, TS version selection (uses bundled 5.8.x), full incremental watch
correctness for files edited outside the app.

## Dependency

`typescript@~5.8.3` — already in `package.json` (used for builds); now also
bundled lazily into the worker chunk. No other new dependencies.

## Testing

- Unit (vitest): protocol RPC helper; VFS path normalization; tsconfig-options
  mapping; completion-entry → CodeMirror mapping (pure functions extracted for
  testability).
- Rust: no changes expected (existing fs commands suffice) — if a batched
  `read_files` command is added for preload performance, it gets a unit test.
- Manual (desktop): open a React project → `useSta` completes with auto-import;
  `user.` lists members; a type error shows a squiggle with the TS message;
  hover shows types; toggles disable it; a non-JS project is unaffected.
