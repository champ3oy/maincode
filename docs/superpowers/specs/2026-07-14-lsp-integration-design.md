# LSP Integration — Design

- **Date:** 2026-07-14
- **Status:** Approved (design); implementation plan pending
- **Owner:** editor / TypeScript intelligence

## Problem

TypeScript intelligence is currently provided by a hand-rolled, single-project
`ts.LanguageService` running in a browser Web Worker (`src/lib/ts-worker/`) over a
lazily-loaded virtual filesystem, with `moduleResolution` forced to `Bundler`.
This architecture fights how TypeScript actually resolves projects, so every
real-world project type exposes a new class of bug:

- **Monorepos** — one `tsconfig.json` per package (often no config at the workspace
  root); `@/*` aliases don't resolve. Partially mitigated by merging `paths`, but
  scalar options and resolution mode are still single-set and wrong per-package.
- **`@types` auto-inclusion** — `getDirectories` returns `[]`, so TS can't enumerate
  `node_modules/@types`; `process`/Node globals surface as errors until they happen
  to arrive transitively.
- **Resolution mode** — forcing `Bundler` mis-resolves `nodenext` projects (e.g.
  `@nestjs/swagger` "has no exported member 'DocumentBuilder'").
- **Document-registry crash** — `impliedNodeFormat` flips as `node_modules`
  package.jsons load lazily, so `releaseOldSourceFile` dereferences an undefined
  registry entry and throws; a crash-guard was added, but it converts the crash
  into *silent empty results* (no diagnostics, hover, or go-to-definition).
- **Other languages** — Python and everything non-TS/JS have no intelligence at all.

These are symptoms of the architecture, not independent bugs. Patching each one is
whack-a-mole.

## Goal

Replace the hand-rolled worker with the reference implementation — real
`tsserver` fronted by `typescript-language-server` — run as a bundled sidecar and
consumed over the Language Server Protocol (LSP). tsserver reads each package's
real `tsconfig.json` (configured projects), does native `@types` inclusion and
`nodenext`/`bundler` resolution, and computes `impliedNodeFormat` correctly, so the
entire bug class disappears at the root. The client is built language-agnostic so
additional servers (pyright, etc.) plug in later.

### Non-goals (this build)

- Wiring any server other than `typescript-language-server` (pyright/Python is a
  follow-up that reuses the same bundled Node + client).
- Replacing Prettier formatting (stays as-is).
- Deleting `src/lib/ts-worker/*` in this build (kept behind a flag until parity is
  proven; deletion is a follow-up PR).

## Decisions

1. **Runtime:** bundle a Node runtime + `typescript-language-server` (+ a pinned
   `typescript`) inside the app. Fully self-contained; no dependency on the user
   having Node. Trade-off accepted: ~50–100 MB app size, one pinned TS version.
2. **Scope:** build a language-agnostic LSP client + Rust transport, but wire and
   test only `typescript-language-server` now. Reach parity with today's features
   and fix the reported bugs.
3. **Cutover:** LSP sits behind a settings flag during development (worker stays
   default). Once parity + stability are proven, flip default to LSP; a follow-up
   PR deletes the worker and the flag. Single engine end-state.
4. **Transport:** a small custom Rust module (`lsp.rs`) mirroring `pty.rs` —
   dependency-free, does `Content-Length` frame parsing in Rust (avoids fragile
   multibyte buffering in JS). (Alternative considered: `tauri-plugin-shell`
   sidecar API — rejected to avoid a new plugin + permission surface.)
5. **Frontend client:** a focused custom LSP client (not a CodeMirror-LSP library)
   — CSP-clean, matches existing `cm.ts` extension shapes, and exposes the same
   interface today's `tsClient()` does, so CodeMirror wiring barely changes.

## Architecture

```
Bundled sidecar:  node + typescript-language-server (+ pinned typescript)
      ↕ stdio (LSP / JSON-RPC, Content-Length framed)
Rust  src-tauri/src/lsp.rs
      · LspState: Mutex<HashMap<root, Session>>  (one server per project root)
      · commands: lsp_spawn(root) -> id, lsp_send(id, msg), lsp_stop(id)
      · reader thread: parses Content-Length frames -> emits `lsp-msg-<id>` (one
        event per complete LSP message); emits `lsp-exit-<id>` on process exit
      ↕ Tauri events + commands
Frontend  src/lib/lsp/
      · transport.ts — wraps the Tauri command/event bridge
      · client.ts    — JSON-RPC: initialize/initialized, didOpen/Change/Close,
                       completion/hover/definition requests, publishDiagnostics
      · protocol.ts  — LSP message types (subset we use)
      ↕ IntelligenceClient interface (same shape as today's tsClient())
CodeMirror  src/lib/ts-worker/cm.ts (adapted to call the selected engine)
      · completion source · linter · hover · go-to-definition affordance
Selector  src/lib/intelligence.ts — returns tsClient() or lspClient() by
      `settings.editor.engine`
```

**Unit boundaries (each independently understandable + testable):**

- **`lsp.rs`** — spawn/kill a server per root and shuttle framed messages. Depends
  on: portable process spawn (already used by `pty.rs`), Tauri events. Testable:
  frame-parser unit tests (split/joined chunks, multibyte).
- **`lsp/client.ts`** — pure TS JSON-RPC + LSP semantics over an injected
  transport. Depends on: a `Transport` interface (send/onMessage). Testable with a
  fake transport feeding canned frames; no Tauri needed.
- **CodeMirror extensions** — engine-agnostic; depend only on the
  `IntelligenceClient` interface.

## Bundling

Ship as Tauri **resources** (not `externalBin` — we invoke `node <script>`, and
resources avoid per-target-triple binary renaming for the JS):

- `resources/lsp/node` — platform Node binary (macOS arm64/x64 to start, matching
  current build targets).
- `resources/lsp/server/` — `typescript-language-server` + pinned `typescript`,
  installed with `npm ci --omit=dev` then pruned to ~15–20 MB.
- `scripts/fetch-lsp.mjs` — a pre-`tauri build` step that downloads the platform
  Node and installs the server into `resources/`, so binaries aren't committed.

`tauri.conf.json` gains `bundle.resources: ["resources/lsp/**"]`. Rust resolves via
`app.path().resolve("lsp/...", BaseDirectory::Resource)` and spawns
`node server/cli.mjs --stdio`. `tauri dev` resolves the same on-disk path, so dev
and prod share one code path.

## Rust transport (`lsp.rs`)

Mirrors `pty.rs` structure:

- `LspState { sessions: Mutex<HashMap<u32, LspSession>>, by_root: Mutex<HashMap<String,u32>>, next_id }`.
- `lsp_spawn(root) -> id`: resolve resource paths, spawn `node server/cli.mjs
  --stdio` with `cwd = root`; if a session for `root` exists, refcount++ and return
  it. Reader thread accumulates stdout, parses `Content-Length: N\r\n\r\n` framing,
  emits one `lsp-msg-<id>` event per complete message (payload = the JSON string).
  A second thread reaps the child and emits `lsp-exit-<id>`.
- `lsp_send(id, msg)`: prepend `Content-Length` header, write to the child stdin.
- `lsp_stop(id)`: refcount--; on zero, close stdin and kill.

Framing lives in Rust so byte boundaries (and multibyte UTF-8 split across chunks)
are handled once, correctly; the frontend only ever sees complete JSON messages.

## Frontend LSP client (`src/lib/lsp/`)

- **`transport.ts`** — `invoke("lsp_spawn", ...)`, `listen("lsp-msg-<id>")`,
  `invoke("lsp_send", ...)`; exposes `{ send(msg), onMessage(cb), onExit(cb) }`.
- **`client.ts`** — JSON-RPC layer: request/response correlation by `id`, handles
  server→client notifications (`publishDiagnostics`, `window/logMessage`).
  Lifecycle: `initialize { rootUri, capabilities }` → `initialized`. Document sync:
  `didOpen` / full-document `didChange` (debounced; incremental is a later
  optimization) / `didClose`. Feature methods:
  `completion` (+ `completionItem/resolve` for auto-imports), `hover`,
  `definition`. Exposes the **`IntelligenceClient`** interface used by CodeMirror.
- **`protocol.ts`** — the LSP subset we use (typed).

### `IntelligenceClient` interface (shared by both engines)

Extracted from today's `tsClient()` so `cm.ts` is engine-agnostic:

```
openProject(root) / closeProject() / ready()
notifyDocChanged(path, content)         // → didChange (LSP) or docChanged (worker)
getCompletions(path, offset)
getCompletionDetails(path, offset, item)
getDiagnostics(path)                    // LSP: last publishDiagnostics for the doc
getHover(path, offset)
getDefinition(path, offset)
onTypesUpdated(fn)                       // LSP: re-render on new publishDiagnostics
```

LSP uses `{line, character}` positions; the client converts to/from CodeMirror
offsets at the boundary (the worker already deals in offsets, so conversion is
localized to the LSP client).

## Document & lifecycle sync

- **One server per project root**, refcounted; multiple windows on the same folder
  share it, different folders get separate servers.
- Open folder → `lsp_spawn(root)` → `initialize`/`initialized`.
- `code-editor.tsx`: on tab view → `didOpen`; existing `updateListener` docChanged
  path → debounced full-document `didChange`; tab close → `didClose`. (The editor
  already tracks all three; this is wiring, not new state.)
- **Diagnostics** are server-pushed via `publishDiagnostics` (vs the worker's pull
  model); the client caches the latest per URI and the CodeMirror `linter` reads
  them / re-lints on `onTypesUpdated`.

## Feature parity → bug resolution

| Feature | Today (worker) | LSP | Reported bug fixed |
|---|---|---|---|
| Diagnostics | pull, forced Bundler | `publishDiagnostics`, real tsconfig | monorepo `@/`, `process`/@types, swagger partial resolution |
| Go-to-definition | worker, single root | `textDocument/definition` | RN cmd+click (no more silent empty) |
| Hover | worker | `textDocument/hover` | "definition popup not coming" |
| Completion + auto-import | worker | `completion` + `resolve` | parity |
| Formatting | Prettier | unchanged (Prettier) | — |

## Settings flag & cutover

- New setting `editor.engine: "worker" | "lsp"`, default `"worker"` during dev.
- `intelligenceClient()` selector returns `tsClient()` or `lspClient()` behind the
  shared interface; `cm.ts` calls the selector.
- On proven parity + stability: default → `"lsp"`; follow-up PR deletes
  `src/lib/ts-worker/*` and the flag.

## Error handling

- **Server won't spawn:** Rust returns an error; client shows a one-time toast and
  the editor degrades to plain editing.
- **Server crash:** `lsp-exit-<id>` → client auto-restarts (capped, exponential
  backoff), replays `didOpen` for visible docs. No silent-empty.
- **Malformed frame / request timeout:** reject the pending request; keep the
  session alive.

## Testing

- **LSP client unit tests** — fake transport feeding canned LSP frames; assert
  framing/correlation, `publishDiagnostics` → CodeMirror diagnostics mapping,
  position↔offset conversion, restart/backoff.
- **`lsp.rs` unit tests** — `Content-Length` frame parser: split across reads,
  multiple frames per read, multibyte UTF-8 split across reads.
- **Integration parity** — spawn the real bundled server against the repro projects
  (the `lugway` monorepo): assert `@/contexts/wallet` resolves, `process` resolves,
  go-to-definition lands in `mobile/contexts/wallet.tsx`, and no crash — the same
  assertions that currently fail on the worker.

## Rollout phases

1. Rust `lsp.rs` + bundling plumbing + a smoke test (spawn, initialize, shutdown).
2. Frontend `lsp/` client + `IntelligenceClient` interface + unit tests.
3. `intelligence.ts` selector + `editor.engine` setting; adapt `cm.ts`.
4. Wire document sync + the four features; integration parity tests on `lugway`.
5. Prove parity/stability → flip default to `"lsp"`.
6. (Follow-up PR) delete `src/lib/ts-worker/*`; (later) add pyright.

## Risks / open questions

- **Node binary sourcing** per platform and app-size impact; confirm signing/notary
  implications of a bundled `node` on macOS.
- **`typescript-language-server` vs `vtsls`** — start with the former; swap is
  localized to the sidecar + install script if fidelity gaps appear.
- **Incremental `didChange`** correctness vs full-document sync — start with full
  sync for safety, move to incremental if needed.
- **Auto-import edits** — LSP `completionItem/resolve` returns `additionalTextEdits`;
  ensure the same doc-safety guarding the worker's auto-import path has.
