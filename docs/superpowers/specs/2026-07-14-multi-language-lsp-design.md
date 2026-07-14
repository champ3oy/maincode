# Multi-Language LSP — Design

- **Date:** 2026-07-14
- **Status:** Approved (design); implementation plan pending
- **Owner:** editor / language intelligence
- **Builds on:** `2026-07-14-lsp-integration-design.md` (the TS-first LSP engine)

## Problem

The editor now has full LSP intelligence for TypeScript/JS (bundled tsserver),
but every other language has **syntax highlighting only** — no diagnostics,
hover, go-to-definition, or completion. We want that intelligence for more
languages, starting with Python, Rust, Go, and C/C++.

The existing LSP machinery was deliberately built language-agnostic; only three
seams are TypeScript-specific and must be generalized.

## Goal

Add LSP intelligence for **Python (pyright), Rust (rust-analyzer), Go (gopls),
and C/C++ (clangd)**, using a **download-on-first-use + cache** model (like VS
Code extensions and Zed) so the app size stays roughly constant and users only
acquire servers for languages they actually open. The design is extensible — a
new language is a registry row plus its download source (catalog:
https://langserver.org/).

### Non-goals (this build)

- Wiring servers beyond the five (TS + Python/Rust/Go/C++). The registry makes
  more trivial to add later.
- Per-server settings tuning (formatting options, inlay hints, etc.) — v1 uses a
  minimal `initialize` like TS.
- Language servers for config/data formats (yaml/toml/json already have
  highlighting; JSON/YAML LSPs are a possible follow-up).

## Decisions

1. **Download-on-first-use + cache**, not bundling the big servers. Servers land
   in `~/.config/maincode/servers/<serverId>/`, shared across projects/launches.
   (`~/.config/maincode/` matches the existing settings dir — see
   `settings.rs::config_dir` = `$HOME/.config`.)
2. **Bundle only the node-based, always-relevant servers**: tsserver (already)
   and pyright (~15 MB, rides the bundled node). The big compiled servers
   (rust-analyzer, clangd) download prebuilt; gopls installs via `go install`.
3. **The server registry is authoritative in Rust.** The frontend can only ever
   pass a known `serverId` — Rust resolves it to a command + acquire strategy, so
   the frontend can never spawn an arbitrary executable.
4. **Servers spawn lazily**, on the first file of their language, and are
   **refcounted per `(window, root, serverId)`** so tsserver + pyright + gopls can
   coexist in one project.
5. **`initialize` is minimal** per server for v1 (rootUri + capabilities), same
   as TS.

## Architecture

```
languageKeyForPath(file) → serverId  (typescript|python|rust|go|cpp | none)
      ↓  (frontend routing table: langKey → serverId)
ClientManager (src/lib/lsp/manager.ts)
  · setRoot(root): store root, close existing clients
  · clientForPath(path): lazily create LspClient(serverId) + openProject(root);
    null when the language has no server (→ highlighting only)
      ↓  invoke("lsp_ensure_server", { serverId })   // download/build if missing
      ↓  invoke("lsp_spawn", { serverId, root })
Rust src-tauri/src/lsp.rs
  · SERVER REGISTRY: serverId → { acquire strategy, command, args }
  · lsp_ensure_server: acquire (download+extract | go install | bundled no-op)
    into the cache, emitting progress events
  · lsp_spawn: resolve serverId → bundled resource OR cached binary, spawn,
    key session by (window_label, root, serverId)
  · frame parser / pipe / per-window cleanup — unchanged
      ↑ LSP JSON-RPC (Content-Length framed) — unchanged client
```

**Unit boundaries:**
- **`server-acquire.rs`** (new Rust module): download a URL to a file, extract
  gz/zip, run `go install`, into the cache. Depends on: an HTTP client + archive
  crates. Testable: extract-to-temp unit tests; download behind a feature/flag.
- **`lsp.rs` registry + ensure/spawn**: maps serverId → command; unchanged frame
  transport. Testable: registry resolution unit tests.
- **`manager.ts`** (frontend): pure routing + lazy client lifecycle over an
  injected "spawn client" fn. Testable with fakes, no Tauri.
- **`LspClient` doc-buffer**: pure TS; buffers didOpen/didChange until ready.

## Server registry

| serverId | languages (ext / name) | acquire | command |
|---|---|---|---|
| typescript | ts, tsx, js, jsx, mjs, cjs, mts, cts | bundled | `node …/typescript-language-server/lib/cli.mjs --stdio` |
| python | py, pyi | bundled | `node …/pyright/langserver.index.js --stdio` (pyright-langserver) |
| rust | rs | github-release | `<cache>/rust/rust-analyzer` |
| go | go | go-install | `<cache>/go/gopls` |
| cpp | c, h, cpp, cc, cxx, hpp, hxx | github-release | `<cache>/cpp/clangd/bin/clangd` |

Acquire strategies:
- **bundled** — resolve under `resources/lsp/` (with the existing dev fallback to
  `CARGO_MANIFEST_DIR/../resources`). No download.
- **github-release** — download `{repo, asset-template(os,arch), archive:
  gz|zip}` from GitHub releases at a pinned version, extract into
  `<cache>/<serverId>/`, mark the binary executable.
- **go-install** — run `go install <pkg>@<version>` with `GOBIN=<cache>/go`
  (requires the user's Go toolchain on PATH; surfaced clearly if absent).

## Acquisition flow (first use)

1. Editor opens a file; `manager.clientForPath(path)` maps to a `serverId`.
2. Manager (once per serverId) calls `invoke("lsp_ensure_server", { serverId })`.
3. Rust: if the target binary exists in cache/resources → return ready. Else run
   the acquire strategy, emitting `lsp-install-<serverId>` progress events
   (`{ phase: "download"|"extract"|"install", pct? }`). The UI shows a toast
   ("Installing the Rust language server…") and clears it on completion/error.
4. On ready, the manager creates `LspClient(serverId)`, calls `openProject(root)`
   (which `lsp_spawn`s the resolved command), and the client buffers/replays doc
   sync as it initializes.

## Client-manager lifecycle

- `setRoot(root)` on folder open: store root; close all existing clients.
- `clientForPath(path)`: `languageKeyForPath` → `serverId` via the routing table;
  `null` (highlighting-only) when no server. Otherwise return the client for that
  serverId, lazily creating `new LspClient(serverId)` and kicking off
  ensure→openProject on first use.
- Folder change/close → close all clients (each `lsp_stop`s its server).

**Doc-buffer (robustness).** Because servers now spawn lazily, files are often
opened before their server finishes `initialize`. `LspClient` tracks open docs
(path→text) and, while not ready, holds `didOpen`/`didChange`, then **replays
them once `initialized` arrives**. (This also fixes a latent gap in the current
TS client where a file opened before init never received `didOpen`.)

## CodeMirror integration

- `getClient` in code-editor.tsx becomes `clientForPath(pathRef.current)` (routes
  by the current tab's language).
- The `isTsWorkerPath(path)` gate in cm.ts becomes `hasLspServer(path)`
  (`languageKeyForPath(path)` maps to a known serverId).
- The extensions (linter/completion/hover/go-to-def) are otherwise unchanged —
  they already operate on whatever `IntelligenceClient` they're handed.

## Runtime toolchain caveats (documented, not hidden)

Bundled/cached *servers* run out of the box, but some shell out to the language
toolchain at runtime for full analysis:
- **gopls** invokes `go`; **pyright** is best with a Python interpreter (falls
  back to bundled stdlib stubs otherwise).
- **rust-analyzer** wants a Cargo project; **clangd** is best with
  `compile_commands.json`.

Because a GUI app launched from Finder has a minimal `PATH`, LSP servers are
spawned with a **login-shell-augmented PATH** (the same fix `pty.rs` already uses)
so they can find `go`/`python`/`cargo`.

## Error handling

- **Acquire fails** (network down, no Go for gopls, no prebuilt for the platform)
  → `lsp-install-<serverId>` error event → one-time toast; that language degrades
  to highlighting-only; others unaffected.
- **Server won't spawn / crashes** → per-client `lsp-exit` → `ready()=false`,
  degrade for that language only (per-client isolation).
- **Corrupt cache** → a checksum/size sanity check; on failure, re-acquire once.

## Testing

- **Rust:** `server-acquire` extract-to-temp unit tests (gz + zip); registry
  resolution unit tests; `lsp.rs` frame parser tests unchanged.
- **Frontend:** `manager.ts` routing + lazy-lifecycle unit tests (fake spawn);
  `LspClient` doc-buffer replay unit tests.
- **Integration parity (per language):** the real-server harness we used for TS,
  driven headlessly against a tiny fixture (a Cargo crate, a Go module, a `.py`,
  a `.cpp`), asserting diagnostics/hover/definition return. `skipIf` the server
  binary/toolchain is absent so CI stays green.

## Rollout phases

1. Generalize Rust `lsp_spawn` (serverId → command) + session key includes
   serverId; frontend `manager.ts` + routing table + `LspClient(serverId)` +
   doc-buffer. Re-verify TS still works (regression guard).
2. `server-acquire.rs` (download+extract, go-install) + `lsp_ensure_server` +
   progress events + cache dir.
3. Wire **pyright** end-to-end (bundled, node-based) as the multi-language proof.
4. Wire **rust-analyzer** + **clangd** (github-release download).
5. Wire **gopls** (go-install).
6. Per-language parity tests; PATH-augmentation for toolchain discovery.

## Risks / open questions

- **Rust dependencies:** need an HTTP client + gz/zip extraction (e.g. `ureq` +
  `flate2`/`zip`, or reuse whatever Tauri already pulls in). Keep it minimal.
- **GitHub rate limits / release-asset naming drift** across platforms — pin
  versions; template asset names per (os, arch); verify size/checksum.
- **PATH augmentation** must not break the sandbox or leak a wrong toolchain;
  mirror `pty.rs` precisely.
- **Windows** later multiplies the acquire matrix (asset names, `.exe`, zip);
  macOS-first for now.
