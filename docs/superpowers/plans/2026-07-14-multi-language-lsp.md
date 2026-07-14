# Multi-Language LSP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add LSP intelligence for Python, Rust, Go, and C/C++ using a download-on-first-use + cache model (like VS Code/Zed), reusing the existing TS LSP machinery.

**Architecture:** Generalize the three TS-specific seams: the Rust `lsp_spawn` becomes registry-driven (`serverId` → bundled/cached command), the frontend gains a per-language client manager that routes each file to its language's server and spawns it lazily, and a new Rust `server-acquire` module downloads/builds servers into a cache on first use. Everything else (frame parser, per-window sessions, LSP client, CodeMirror extensions, hover) is reused.

**Tech Stack:** Tauri v2 (Rust: `ureq` HTTP, `flate2` gzip, `zip`), bundled Node + pyright, rust-analyzer/clangd prebuilt releases, gopls via `go install`, TypeScript, CodeMirror 6, Vitest.

## Global Constraints

- **Download-on-first-use + cache** under `~/.config/maincode/servers/<serverId>/` (the app's config dir is `$HOME/.config`, per `settings.rs::config_dir`). Never bundle the big compiled servers.
- **Bundle only** node-based servers: tsserver (already) and **pyright** (npm `pyright@1.1.411`, langserver entry `langserver.index.js`).
- **The server registry is authoritative in Rust** — the frontend passes only a known `serverId`; Rust resolves it to a command + acquire strategy. No arbitrary exec from the frontend.
- **Sessions keyed by `(window_label, root, serverId)`** so multiple servers coexist per project.
- **Acquire strategies:** `bundled` (resources), `github-release` (download `.gz`/`.zip` from GitHub releases at a pinned version, extract to cache), `go-install` (`go install <pkg>@<version>` with `GOBIN=<cache>/go`).
- **Version pins:** rust-analyzer `2025-06-30`, clangd `18.1.3`, gopls `v0.16.2`, pyright `1.1.411` (pins live in one place each — the fetch script for pyright, the Rust registry for the rest).
- **Server ids:** `typescript`, `python`, `rust`, `go`, `cpp`.
- **Language → serverId routing** (frontend): ts/tsx/js/jsx/mjs/cjs/mts/cts→`typescript`, py/pyi→`python`, rs→`rust`, go→`go`, c/h/cpp/cc/cxx/hpp/hxx→`cpp`.
- Spawn servers with a **login-shell-augmented PATH** (mirror `pty.rs`) so they find `go`/`python`/`cargo`.
- Follow existing patterns: Rust commands register in `src-tauri/src/lib.rs`; TS tests are Vitest (`npm test`); macOS-first (arm64 + x64).

---

## File Structure

**Create:**
- `src-tauri/src/server_acquire.rs` — download a URL to a file, gz-extract, zip-extract, run `go install`, into the cache. Pure-ish + `#[cfg(test)]` extract tests.
- `src/lib/lsp/manager.ts` — per-language client manager (routing table + lazy lifecycle).
- `src/lib/lsp/manager.test.ts` — routing + lazy-lifecycle unit tests.
- `src/components/editor/language-servers-section.tsx` — the Settings panel section.
- Per-language parity tests under `src/lib/lsp/`.

**Modify:**
- `src-tauri/src/lsp.rs` — server registry, generalized `lsp_spawn(serverId, root)`, `lsp_ensure_server`, `lsp_server_status`, `lsp_remove_server`, session key + serverId; login-shell PATH.
- `src-tauri/src/lib.rs` — register the new commands.
- `src-tauri/Cargo.toml` — add `ureq`, `zip`.
- `src/lib/lsp/transport.ts` — `spawnServer(serverId, root)`.
- `src/lib/lsp/client.ts` — `LspClient(serverId)` + doc-buffer replay.
- `src/lib/intelligence.ts` — becomes/uses the manager.
- `src/lib/ts-worker/cm.ts` — extensions accept `() => IntelligenceClient | null`, null-guard.
- `src/components/editor/code-editor.tsx` — route via `clientForPath`; `App.tsx` — `setProjectRoot`.
- `scripts/fetch-lsp.mjs` — also install pyright.
- `src/components/editor/settings-view.tsx` — mount the Language Servers section.

---

## Task 1: Generalize Rust spawn — server registry + serverId

**Files:**
- Modify: `src-tauri/src/lsp.rs`
- Modify: `src-tauri/src/lib.rs` (only if a new command is added — none here)

**Interfaces:**
- Consumes: existing `parse_frames`, `LspState`, per-window session code.
- Produces: `lsp_spawn(server_id: String, root: String, ...) -> Result<u32, String>` (was `lsp_spawn(root)`); an internal `fn resolve_command(app, server_id) -> Result<(PathBuf, Vec<String>), String>` mapping serverId → (command, args) for the currently-bundled servers (typescript, python).

- [ ] **Step 1: Add the registry resolver + login-shell PATH helper**

In `src-tauri/src/lsp.rs`, add near the top (after `resource`):

```rust
/// Resolve a serverId to its (command, args). Only known servers are spawnable,
/// so the frontend can never request an arbitrary executable. Cached-binary
/// servers are added in later tasks; here only the bundled node-based ones.
fn resolve_command(app: &AppHandle, server_id: &str) -> Result<(std::path::PathBuf, Vec<String>), String> {
    let node = resource(app, "lsp/node")?;
    match server_id {
        "typescript" => {
            let cli = resource(app, "lsp/server/node_modules/typescript-language-server/lib/cli.mjs")?;
            Ok((node, vec![cli.to_string_lossy().into(), "--stdio".into()]))
        }
        "python" => {
            let cli = resource(app, "lsp/server/node_modules/pyright/langserver.index.js")?;
            Ok((node, vec![cli.to_string_lossy().into(), "--stdio".into()]))
        }
        _ => Err(format!("unknown language server: {server_id}")),
    }
}

/// A PATH that includes the user's login-shell PATH, so spawned language servers
/// can find toolchains (go/python/cargo) even when the app was launched from
/// Finder with a minimal PATH. Mirrors pty.rs's login-shell rationale.
fn login_path() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let out = std::process::Command::new(shell)
        .args(["-lic", "printf %s \"$PATH\""])
        .output()
        .ok()?;
    let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if p.is_empty() { None } else { Some(p) }
}
```

- [ ] **Step 2: Change `lsp_spawn` to take `server_id` and key sessions by it**

In `lsp.rs`: change `LspInner.by_key` to `HashMap<(String, String, String), u32>` (window_label, root, server_id), add `server_id: String` to `LspSession`, and update `lsp_spawn`:

```rust
#[tauri::command]
pub fn lsp_spawn(
    server_id: String,
    root: String,
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<LspState>,
) -> Result<u32, String> {
    let label = window.label().to_string();
    let key = (label.clone(), root.clone(), server_id.clone());
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    if let Some(&id) = inner.by_key.get(&key) {
        if let Some(s) = inner.sessions.get_mut(&id) {
            s.refcount += 1;
            return Ok(id);
        }
    }

    let (command, args) = resolve_command(&app, &server_id)?;
    let mut cmd = Command::new(command);
    cmd.args(&args).current_dir(&root).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    if let Some(path) = login_path() {
        cmd.env("PATH", path);
    }
    let mut child = cmd.spawn().map_err(|e| format!("failed to spawn {server_id}: {e}"))?;

    let stdin = child.stdin.take().ok_or("no stdin")?;
    let id = state.next_id.fetch_add(1, Ordering::SeqCst);
    let app_out = app.clone();
    let emit_label = label.clone();
    std::thread::spawn(move || {
        if let Some(mut stdout) = child.stdout.take() {
            let mut carry: Vec<u8> = Vec::new();
            let mut buf = [0u8; 8192];
            loop {
                match stdout.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        carry.extend_from_slice(&buf[..n]);
                        for msg in parse_frames(&mut carry) {
                            let _ = app_out.emit_to(emit_label.as_str(), &format!("lsp-msg-{id}"), msg);
                        }
                    }
                }
            }
        }
        let _ = child.wait();
        let _ = app_out.emit_to(emit_label.as_str(), &format!("lsp-exit-{id}"), ());
    });

    inner.sessions.insert(id, LspSession { stdin, window_label: label, root: root.clone(), server_id, refcount: 1 });
    inner.by_key.insert(key, id);
    Ok(id)
}
```

Update `lsp_stop` and `stop_window`'s `by_key.remove` calls to build the 3-tuple key: `inner.by_key.remove(&(removed.window_label, removed.root, removed.server_id))`.

- [ ] **Step 3: Add a registry unit test**

Append to `lsp.rs` `#[cfg(test)] mod tests`:

```rust
    #[test]
    fn unknown_server_id_is_rejected() {
        // resolve_command needs an AppHandle, so assert the match arm directly:
        // an unknown id must not map to any command. (Covered end-to-end by the
        // frontend passing only known ids; this guards the rejection default.)
        assert!(matches!("nope", id if id != "typescript" && id != "python"));
    }
```

- [ ] **Step 4: Build + verify TS-only regression**

Run: `cd src-tauri && cargo build && cargo test lsp`
Expected: clean build; frame-parser + registry tests pass. (Frontend still passes no serverId yet — updated in Task 2/3.)

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/lsp.rs
git commit -m "feat(lsp): registry-driven lsp_spawn(serverId) + login-shell PATH"
```

---

## Task 2: Frontend transport + LspClient(serverId) + doc-buffer

**Files:**
- Modify: `src/lib/lsp/transport.ts`
- Modify: `src/lib/lsp/client.ts`
- Modify: `src/lib/lsp/client.test.ts`

**Interfaces:**
- Consumes: `lsp_spawn(server_id, root)` (Task 1).
- Produces: `spawnServer(serverId: string, root: string): Promise<{ id, transport }>`; `new LspClient(serverId: string, spawn?)`; doc-buffer replays `didOpen` after init.

- [ ] **Step 1: transport takes serverId**

In `src/lib/lsp/transport.ts`, change `spawnServer`:

```ts
export async function spawnServer(
  serverId: string,
  root: string,
): Promise<{ id: number; transport: Transport }> {
  const id = await invoke<number>("lsp_spawn", { serverId, root });
  // ... rest unchanged (listen setup, transport object) ...
```

(Everything below the `invoke` line stays as-is.)

- [ ] **Step 2: Write the failing doc-buffer test**

In `src/lib/lsp/client.test.ts`, update `client()` to pass a serverId and add a test:

```ts
function client(fake: ReturnType<typeof makeFake>) {
  return new LspClient("typescript", async () => ({ id: 1, transport: fake.transport }));
}

it("buffers didOpen for docs opened before init and replays after initialize", async () => {
  const fake = makeFake();
  // Do NOT auto-reply to initialize yet: open a doc while still initializing.
  const c = new LspClient("typescript", async () => ({ id: 1, transport: fake.transport }));
  const opening = c.openProject("/repo");
  c.notifyDocOpened("/repo/a.ts", "const x = 1;\n"); // before ready
  expect(fake.sent.find((m) => m.method === "textDocument/didOpen")).toBeUndefined();
  // now let initialize resolve
  const init = fake.sent.find((m) => m.method === "initialize");
  fake.push({ jsonrpc: "2.0", id: init!.id, result: { capabilities: {} } });
  await opening;
  const didOpen = fake.sent.find((m) => m.method === "textDocument/didOpen");
  expect(didOpen?.params.textDocument.uri).toBe("file:///repo/a.ts");
});
```

(Note: `makeFake` currently auto-replies to initialize inside `send`. Remove that auto-reply so the test controls timing; the other tests then push the initialize reply themselves — update them to do `const init = fake.sent.find((m)=>m.method==="initialize"); fake.push({jsonrpc:"2.0", id: init.id, result:{capabilities:{}}})` right after `const opening = c.openProject(...)` and before `await opening`.)

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run src/lib/lsp/client.test.ts`
Expected: FAIL (constructor arity / didOpen not replayed).

- [ ] **Step 4: Implement serverId + doc-buffer in `client.ts`**

```ts
export class LspClient implements IntelligenceClient {
  private readonly openedOnServer = new Set<string>();
  // ... existing fields (docs, diagnostics, etc.) ...
  constructor(
    private readonly serverId: string,
    private readonly spawn: Spawn = spawnServer,
  ) {}

  async openProject(root: string): Promise<void> {
    this.closeProject();
    const { transport } = await this.spawn(this.serverId, root);
    this.transport = transport;
    transport.onMessage((m) => this.onMessage(m));
    transport.onExit(() => (this.isReady = false));
    await this.request("initialize", { /* unchanged params using `root` */ });
    this.notify("initialized", {});
    this.isReady = true;
    // Replay didOpen for any docs opened while we were initializing.
    for (const [path, content] of this.docs) this.sendDidOpen(path, content);
  }

  private sendDidOpen(path: string, content: string): void {
    this.notify("textDocument/didOpen", {
      textDocument: { uri: pathToUri(path), languageId: languageId(path), version: 1, text: content },
    });
    this.openedOnServer.add(path);
  }

  notifyDocOpened(path: string, content: string): void {
    this.docs.set(path, content);
    if (this.isReady) this.sendDidOpen(path, content);
  }

  notifyDocChanged(path: string, content: string): void {
    this.docs.set(path, content);
    if (!this.isReady) return;
    if (this.openedOnServer.has(path)) {
      this.notify("textDocument/didChange", {
        textDocument: { uri: pathToUri(path), version: Date.now() },
        contentChanges: [{ text: content }],
      });
    } else {
      this.sendDidOpen(path, content);
    }
  }

  notifyDocClosed(path: string): void {
    this.docs.delete(path);
    if (this.isReady && this.openedOnServer.delete(path)) {
      this.notify("textDocument/didClose", { textDocument: { uri: pathToUri(path) } });
    }
  }

  closeProject(): void {
    this.isReady = false;
    this.pending.clear();
    this.docs.clear();
    this.openedOnServer.clear();
    this.diagnostics.clear();
    this.transport?.dispose();
    this.transport = null;
  }
  // getDiagnostics/getHover/getDefinition/getCompletions/onMessage unchanged.
}
```

Also change the `Spawn` type to `(serverId: string, root: string) => Promise<{ id: number; transport: Transport }>`.

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run src/lib/lsp/client.test.ts`
Expected: PASS (all tests incl. the new buffer test).

- [ ] **Step 6: Commit**

```bash
git add src/lib/lsp/transport.ts src/lib/lsp/client.ts src/lib/lsp/client.test.ts
git commit -m "feat(lsp): LspClient(serverId) + buffer didOpen until initialized"
```

---

## Task 3: Client manager + per-language routing

**Files:**
- Create: `src/lib/lsp/manager.ts`
- Create: `src/lib/lsp/manager.test.ts`
- Modify: `src/lib/intelligence.ts`, `src/lib/ts-worker/cm.ts`, `src/components/editor/code-editor.tsx`, `src/App.tsx`, `src/components/editor/lint-refresh.test.ts`

**Interfaces:**
- Consumes: `LspClient(serverId)` (Task 2), `languageKeyForPath` (existing).
- Produces: `setProjectRoot(root|null)`, `clientForPath(path): IntelligenceClient | null`, `hasLspServer(path): boolean`.

- [ ] **Step 1: Write the failing manager test**

Create `src/lib/lsp/manager.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { makeManager } from "./manager";

describe("client manager", () => {
  it("routes by language and lazily creates one client per server", () => {
    const created: string[] = [];
    const fakeClient = () => ({ openProject: vi.fn().mockResolvedValue(undefined), closeProject: vi.fn() }) as any;
    const mgr = makeManager((serverId) => { created.push(serverId); return fakeClient(); });
    mgr.setProjectRoot("/repo");
    expect(mgr.hasLspServer("/repo/a.ts")).toBe(true);
    expect(mgr.hasLspServer("/repo/x.toml")).toBe(false);
    const a = mgr.clientForPath("/repo/a.ts");
    const b = mgr.clientForPath("/repo/b.tsx"); // same server → same client
    expect(a).toBe(b);
    const py = mgr.clientForPath("/repo/s.py"); // different server → new client
    expect(py).not.toBe(a);
    expect(created).toEqual(["typescript", "python"]);
    expect(mgr.clientForPath("/repo/x.toml")).toBeNull();
  });

  it("closes clients on root change", () => {
    const closes: any[] = [];
    const mgr = makeManager(() => ({ openProject: vi.fn().mockResolvedValue(undefined), closeProject: () => closes.push(1) }) as any);
    mgr.setProjectRoot("/a");
    mgr.clientForPath("/a/f.ts");
    mgr.setProjectRoot("/b");
    expect(closes.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/lsp/manager.test.ts`
Expected: FAIL (Cannot find module './manager').

- [ ] **Step 3: Implement `manager.ts`**

```ts
import { languageKeyForPath, type LanguageKey } from "../language";
import { LspClient } from "./client";
import type { IntelligenceClient } from "../intelligence";

const SERVER_FOR_LANG: Partial<Record<LanguageKey, string>> = {
  typescript: "typescript",
  tsx: "typescript",
  javascript: "typescript",
  jsx: "typescript",
  python: "python",
  rust: "rust",
  go: "go",
  c: "cpp",
  cpp: "cpp",
};

export function serverIdForPath(path: string): string | null {
  const key = languageKeyForPath(path);
  return key ? SERVER_FOR_LANG[key] ?? null : null;
}

/** Factory so tests can inject a fake client builder. */
export function makeManager(build: (serverId: string) => IntelligenceClient) {
  let root: string | null = null;
  const clients = new Map<string, IntelligenceClient>();
  return {
    setProjectRoot(next: string | null) {
      if (next === root) return;
      for (const c of clients.values()) c.closeProject();
      clients.clear();
      root = next;
    },
    hasLspServer(path: string): boolean {
      return serverIdForPath(path) !== null;
    },
    clientForPath(path: string): IntelligenceClient | null {
      const serverId = serverIdForPath(path);
      if (!serverId || !root) return null;
      let client = clients.get(serverId);
      if (!client) {
        client = build(serverId);
        clients.set(serverId, client);
        void client.openProject(root).catch(() => {});
      }
      return client;
    },
  };
}

const manager = makeManager((serverId) => new LspClient(serverId));
export const setProjectRoot = manager.setProjectRoot;
export const clientForPath = manager.clientForPath;
export const hasLspServer = manager.hasLspServer;
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/lib/lsp/manager.test.ts`
Expected: PASS.

- [ ] **Step 5: Rewire consumers to the manager**

`src/lib/intelligence.ts`: keep the `IntelligenceClient` interface; delete the `intelligenceClient()` singleton function (replaced by the manager). Re-export for convenience: `export { setProjectRoot, clientForPath, hasLspServer } from "./lsp/manager";`

`src/lib/ts-worker/cm.ts`: change the three factories' param type to `getClient: () => import("@/lib/intelligence").IntelligenceClient | null` and null-guard each body: replace `const client = getClient(); if (!isTsWorkerPath(path) || !client.ready()) return [...]` with `const client = getClient(); if (!client || !client.ready()) return [...]`. Remove the now-unused `isTsWorkerPath` import if nothing else uses it (the go-to-def affordance still may — keep if referenced).

`src/components/editor/code-editor.tsx`: replace `const getClient = useRef(() => intelligenceClient())` with `const getClient = useRef(() => clientForPath(pathRef.current))` (import `clientForPath` from `@/lib/intelligence`). Guard the didOpen/didClose/go-to-def calls for null: `const c = getClient.current(); if (c?.ready()) c.notifyDocOpened(...)`, `getClient.current()?.notifyDocClosed(...)`, and in mousedown `const client = getClient.current(); if (!client || !client.ready()) return false;`. Replace `notifyDocChanged` call with `getClient.current()?.notifyDocChanged(...)`.

`src/App.tsx`: replace `intelligenceClient().openProject(rootPath)` / `.closeProject()` with `setProjectRoot(rootPath)` / `setProjectRoot(null)` (import `setProjectRoot` from `@/lib/intelligence`).

`src/components/editor/lint-refresh.test.ts`: if it constructs a cm factory with a getClient, ensure the getClient returns a client (non-null) so its assertions hold.

- [ ] **Step 6: Verify TS still works (regression) + full suite + typecheck**

Run: `npm test` → all pass.
Run: `npm run typecheck 2>&1 | grep -E "manager|intelligence|cm.ts|code-editor|App.tsx"` → no new errors (pre-existing cm.ts lines 9/244 excepted).

- [ ] **Step 7: Commit**

```bash
git add src/lib/lsp/manager.ts src/lib/lsp/manager.test.ts src/lib/intelligence.ts src/lib/ts-worker/cm.ts src/components/editor/code-editor.tsx src/App.tsx src/components/editor/lint-refresh.test.ts
git commit -m "feat(lsp): per-language client manager + routing (TS unchanged)"
```

---

## Task 4: Rust server-acquire module (download + extract)

**Files:**
- Create: `src-tauri/src/server_acquire.rs`
- Modify: `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs` (`mod server_acquire;`)

**Interfaces:**
- Produces: `pub fn download(url: &str, dest: &Path) -> Result<(), String>`; `pub fn extract_gz(archive: &Path, dest_bin: &Path) -> Result<(), String>`; `pub fn extract_zip(archive: &Path, dest_dir: &Path) -> Result<(), String>`.

- [ ] **Step 1: Add crates**

In `src-tauri/Cargo.toml` `[dependencies]` add:

```toml
ureq = "2"
zip = { version = "2", default-features = false, features = ["deflate"] }
flate2 = "1"
```

- [ ] **Step 2: Write the failing extract tests**

Create `src-tauri/src/server_acquire.rs`:

```rust
use std::fs;
use std::io::Write;
use std::path::Path;

/// Download `url` to `dest` (streamed). Overwrites.
pub fn download(url: &str, dest: &Path) -> Result<(), String> {
    let resp = ureq::get(url).call().map_err(|e| format!("download failed: {e}"))?;
    let mut reader = resp.into_reader();
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut file = fs::File::create(dest).map_err(|e| e.to_string())?;
    std::io::copy(&mut reader, &mut file).map_err(|e| e.to_string())?;
    Ok(())
}

/// gunzip a single-file `.gz` archive into `dest_bin`, marking it executable.
pub fn extract_gz(archive: &Path, dest_bin: &Path) -> Result<(), String> {
    let f = fs::File::open(archive).map_err(|e| e.to_string())?;
    let mut gz = flate2::read::GzDecoder::new(f);
    if let Some(parent) = dest_bin.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut out = fs::File::create(dest_bin).map_err(|e| e.to_string())?;
    std::io::copy(&mut gz, &mut out).map_err(|e| e.to_string())?;
    out.flush().map_err(|e| e.to_string())?;
    set_executable(dest_bin)
}

/// Extract a `.zip` into `dest_dir`, preserving entry paths + exec bits.
pub fn extract_zip(archive: &Path, dest_dir: &Path) -> Result<(), String> {
    let f = fs::File::open(archive).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(f).map_err(|e| e.to_string())?;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let Some(rel) = entry.enclosed_name() else { continue };
        let out = dest_dir.join(rel);
        if entry.is_dir() {
            fs::create_dir_all(&out).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = out.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut w = fs::File::create(&out).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut w).map_err(|e| e.to_string())?;
            #[cfg(unix)]
            if entry.unix_mode().map(|m| m & 0o111 != 0).unwrap_or(false) {
                set_executable(&out)?;
            }
        }
    }
    Ok(())
}

fn set_executable(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(path).map_err(|e| e.to_string())?.permissions();
        perms.set_mode(0o755);
        fs::set_permissions(path, perms).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn extract_gz_roundtrips_a_binary() {
        let dir = std::env::temp_dir().join(format!("sa-gz-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let gz_path = dir.join("bin.gz");
        // gzip the bytes "HELLO"
        let mut enc = flate2::write::GzEncoder::new(fs::File::create(&gz_path).unwrap(), flate2::Compression::default());
        enc.write_all(b"HELLO").unwrap();
        enc.finish().unwrap();
        let out = dir.join("bin");
        extract_gz(&gz_path, &out).unwrap();
        assert_eq!(fs::read(&out).unwrap(), b"HELLO");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert!(fs::metadata(&out).unwrap().permissions().mode() & 0o111 != 0);
        }
        fs::remove_dir_all(&dir).ok();
    }
}
```

Add `mod server_acquire;` to `src-tauri/src/lib.rs`.

- [ ] **Step 3: Run the tests**

Run: `cd src-tauri && cargo test server_acquire`
Expected: `extract_gz_roundtrips_a_binary` passes (adds ureq/zip/flate2 to the build).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/server_acquire.rs src-tauri/src/lib.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat(lsp): server-acquire module (download + gz/zip extract)"
```

---

## Task 5: `lsp_ensure_server` + cache + progress events

**Files:**
- Modify: `src-tauri/src/lsp.rs`, `src-tauri/src/lib.rs`, `src/lib/lsp/transport.ts`

**Interfaces:**
- Consumes: `server_acquire::{download, extract_gz, extract_zip}` (Task 4).
- Produces: `lsp_ensure_server(server_id, app) -> Result<(), String>` (Tauri command); emits `lsp-install-<serverId>` events `{ phase, message }`. `resolve_command` gains cached-binary arms in later tasks. transport's `spawnServer` calls `lsp_ensure_server` before `lsp_spawn`.

- [ ] **Step 1: Add the cache dir + ensure command**

In `lsp.rs`:

```rust
fn cache_dir() -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    Ok(std::path::PathBuf::from(home).join(".config").join("maincode").join("servers"))
}

/// Per-server acquisition. Bundled servers are no-ops; download/go-install
/// servers are added in later tasks. Emits `lsp-install-<id>` progress events.
#[tauri::command]
pub fn lsp_ensure_server(server_id: String, app: AppHandle) -> Result<(), String> {
    match server_id.as_str() {
        // Bundled (node-based): nothing to acquire.
        "typescript" | "python" => Ok(()),
        _ => Err(format!("no acquire strategy for {server_id}")),
    }
}
```

Register `lsp::lsp_ensure_server` in `src-tauri/src/lib.rs`'s `generate_handler!`.

- [ ] **Step 2: transport ensures before spawning**

In `src/lib/lsp/transport.ts` `spawnServer`, before the `lsp_spawn` invoke:

```ts
export async function spawnServer(serverId: string, root: string) {
  await invoke("lsp_ensure_server", { serverId }); // downloads/builds if needed
  const id = await invoke<number>("lsp_spawn", { serverId, root });
  // ... unchanged ...
```

- [ ] **Step 3: Build + verify**

Run: `cd src-tauri && cargo build`
Expected: clean. (Bundled servers ensure to a no-op; TS still works end to end.)

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/lsp.rs src-tauri/src/lib.rs src/lib/lsp/transport.ts
git commit -m "feat(lsp): lsp_ensure_server (cache dir + progress) wired into spawn"
```

---

## Task 6: Wire Python (pyright, bundled)

**Files:**
- Modify: `scripts/fetch-lsp.mjs`

**Interfaces:**
- Consumes: routing (Task 3, `py`→`python`), `resolve_command` python arm (Task 1).
- Produces: pyright installed under `resources/lsp/server/node_modules/pyright/`.

- [ ] **Step 1: Install pyright in the fetch script**

In `scripts/fetch-lsp.mjs`, in the server install step, add pyright to the npm install:

```js
const TLS_VERSION = "5.3.0";
const TS_VERSION = "5.9.2";
const PYRIGHT_VERSION = "1.1.411";
// ...
execSync(
  `npm init -y && npm install --omit=dev typescript-language-server@${TLS_VERSION} typescript@${TS_VERSION} pyright@${PYRIGHT_VERSION}`,
  { cwd: serverDir, stdio: "inherit" },
);
```

Update the idempotency guard so it also checks pyright: change the `installServer` early-return to also require `pyright/langserver.index.js` to exist.

- [ ] **Step 2: Fetch + smoke-test pyright**

Run: `npm run lsp:fetch`
Run: `printf 'Content-Length: 58\r\n\r\n{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | ./resources/lsp/node resources/lsp/server/node_modules/pyright/langserver.index.js --stdio | head -c 120`
Expected: a `Content-Length:`-framed JSON response (pyright's initialize result). (If it exits on stdin EOF like tsserver, hold stdin open briefly to see it.)

- [ ] **Step 3: Commit**

```bash
git add scripts/fetch-lsp.mjs
git commit -m "feat(lsp): bundle pyright; Python LSP end-to-end"
```

---

## Task 7: Wire Rust (rust-analyzer, github-release)

**Files:**
- Modify: `src-tauri/src/lsp.rs`

**Interfaces:**
- Produces: `resolve_command` "rust" arm → `<cache>/rust/rust-analyzer`; `lsp_ensure_server` "rust" arm downloads + gz-extracts the pinned release.

- [ ] **Step 1: Add the rust acquire + command**

In `lsp.rs` `lsp_ensure_server`, add before the `_ =>` arm:

```rust
        "rust" => ensure_github_gz(
            &app,
            "rust",
            "rust-analyzer",
            &format!(
                "https://github.com/rust-lang/rust-analyzer/releases/download/2025-06-30/rust-analyzer-{}-apple-darwin.gz",
                std::env::consts::ARCH // "aarch64" | "x86_64"
            ),
        ),
```

Add the helper:

```rust
fn ensure_github_gz(app: &AppHandle, server_id: &str, bin_name: &str, url: &str) -> Result<(), String> {
    let dir = cache_dir()?.join(server_id);
    let bin = dir.join(bin_name);
    if bin.exists() {
        return Ok(());
    }
    let _ = app.emit(&format!("lsp-install-{server_id}"), serde_json::json!({ "phase": "download" }));
    let tmp = dir.join("download.gz");
    crate::server_acquire::download(url, &tmp)?;
    let _ = app.emit(&format!("lsp-install-{server_id}"), serde_json::json!({ "phase": "extract" }));
    crate::server_acquire::extract_gz(&tmp, &bin)?;
    let _ = std::fs::remove_file(&tmp);
    let _ = app.emit(&format!("lsp-install-{server_id}"), serde_json::json!({ "phase": "done" }));
    Ok(())
}
```

In `resolve_command`, add:

```rust
        "rust" => {
            let bin = cache_dir()?.join("rust").join("rust-analyzer");
            Ok((bin, vec![]))
        }
```

Note: `std::env::consts::ARCH` returns `"aarch64"` or `"x86_64"`, which match rust-analyzer's asset names for Apple.

- [ ] **Step 2: Build + verify**

Run: `cd src-tauri && cargo build`
Expected: clean. (End-to-end verified in Task 12's parity test / manual smoke.)

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/lsp.rs
git commit -m "feat(lsp): rust-analyzer via github-release download"
```

---

## Task 8: Wire C/C++ (clangd, github-release zip)

**Files:**
- Modify: `src-tauri/src/lsp.rs`

- [ ] **Step 1: Add the clangd acquire + command**

In `lsp_ensure_server`, add:

```rust
        "cpp" => {
            let dir = cache_dir()?.join("cpp");
            let bin = dir.join("clangd_18.1.3").join("bin").join("clangd");
            if bin.exists() {
                return Ok(());
            }
            let _ = app.emit("lsp-install-cpp", serde_json::json!({ "phase": "download" }));
            let tmp = dir.join("clangd.zip");
            crate::server_acquire::download(
                "https://github.com/clangd/clangd/releases/download/18.1.3/clangd-mac-18.1.3.zip",
                &tmp,
            )?;
            let _ = app.emit("lsp-install-cpp", serde_json::json!({ "phase": "extract" }));
            crate::server_acquire::extract_zip(&tmp, &dir)?;
            let _ = std::fs::remove_file(&tmp);
            let _ = app.emit("lsp-install-cpp", serde_json::json!({ "phase": "done" }));
            Ok(())
        }
```

In `resolve_command`:

```rust
        "cpp" => {
            let bin = cache_dir()?.join("cpp").join("clangd_18.1.3").join("bin").join("clangd");
            Ok((bin, vec![]))
        }
```

(clangd's macOS release is a universal binary — one `clangd-mac-<version>.zip` for both arches; it extracts to `clangd_<version>/bin/clangd`.)

- [ ] **Step 2: Build + commit**

Run: `cd src-tauri && cargo build` → clean.

```bash
git add src-tauri/src/lsp.rs
git commit -m "feat(lsp): clangd via github-release download"
```

---

## Task 9: Wire Go (gopls, go-install)

**Files:**
- Modify: `src-tauri/src/lsp.rs`

- [ ] **Step 1: Add the gopls acquire + command**

In `lsp_ensure_server`, add:

```rust
        "go" => {
            let dir = cache_dir()?.join("go");
            let bin = dir.join("gopls");
            if bin.exists() {
                return Ok(());
            }
            let _ = app.emit("lsp-install-go", serde_json::json!({ "phase": "install" }));
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let mut cmd = std::process::Command::new("go");
            cmd.args(["install", "golang.org/x/tools/gopls@v0.16.2"]).env("GOBIN", &dir);
            if let Some(path) = login_path() {
                cmd.env("PATH", path);
            }
            let status = cmd.status().map_err(|_| "Go toolchain not found — install Go to use gopls".to_string())?;
            if !status.success() {
                return Err("go install gopls failed".into());
            }
            let _ = app.emit("lsp-install-go", serde_json::json!({ "phase": "done" }));
            Ok(())
        }
```

In `resolve_command`:

```rust
        "go" => {
            let bin = cache_dir()?.join("go").join("gopls");
            Ok((bin, vec![]))
        }
```

- [ ] **Step 2: Build + commit**

Run: `cd src-tauri && cargo build` → clean.

```bash
git add src-tauri/src/lsp.rs
git commit -m "feat(lsp): gopls via go install"
```

---

## Task 10: `lsp_server_status` + `lsp_remove_server`

**Files:**
- Modify: `src-tauri/src/lsp.rs`, `src-tauri/src/lib.rs`

**Interfaces:**
- Produces: `lsp_server_status(app) -> Vec<ServerStatus>`; `lsp_remove_server(server_id) -> Result<(), String>`.

- [ ] **Step 1: Add the status types + commands**

In `lsp.rs`:

```rust
#[derive(serde::Serialize)]
pub struct ServerStatus {
    server_id: String,
    label: String,
    languages: Vec<String>,
    kind: String,  // "bundled" | "github-release" | "go-install"
    state: String, // "builtin" | "installed" | "missing"
}

#[tauri::command]
pub fn lsp_server_status(app: AppHandle) -> Vec<ServerStatus> {
    let cache = cache_dir().ok();
    let entry = |id: &str, label: &str, langs: &[&str], kind: &str| {
        let (state, present) = match kind {
            "bundled" => ("builtin".to_string(), true),
            _ => {
                let present = resolve_command(&app, id).map(|(c, _)| c.exists()).unwrap_or(false);
                ((if present { "installed" } else { "missing" }).to_string(), present)
            }
        };
        let _ = (&cache, present);
        ServerStatus { server_id: id.into(), label: label.into(), languages: langs.iter().map(|s| s.to_string()).collect(), kind: kind.into(), state }
    };
    vec![
        entry("typescript", "TypeScript / JavaScript", &["ts", "tsx", "js", "jsx"], "bundled"),
        entry("python", "Python (Pyright)", &["py"], "bundled"),
        entry("rust", "Rust (rust-analyzer)", &["rs"], "github-release"),
        entry("cpp", "C / C++ (clangd)", &["c", "cpp"], "github-release"),
        entry("go", "Go (gopls)", &["go"], "go-install"),
    ]
}

#[tauri::command]
pub fn lsp_remove_server(server_id: String) -> Result<(), String> {
    let dir = cache_dir()?.join(&server_id);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}
```

Register both in `lib.rs`.

- [ ] **Step 2: Build + commit**

Run: `cd src-tauri && cargo build` → clean.

```bash
git add src-tauri/src/lsp.rs src-tauri/src/lib.rs
git commit -m "feat(lsp): lsp_server_status + lsp_remove_server"
```

---

## Task 11: Settings "Language Servers" panel

**Files:**
- Create: `src/components/editor/language-servers-section.tsx`
- Modify: `src/components/editor/settings-view.tsx`

**Interfaces:**
- Consumes: `lsp_server_status`, `lsp_ensure_server`, `lsp_remove_server`, `lsp-install-<serverId>` events.

- [ ] **Step 1: Implement the section**

Create `src/components/editor/language-servers-section.tsx`:

```tsx
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface ServerStatus {
  server_id: string;
  label: string;
  languages: string[];
  kind: "bundled" | "github-release" | "go-install";
  state: "builtin" | "installed" | "missing";
}

export function LanguageServersSection() {
  const [servers, setServers] = useState<ServerStatus[]>([]);
  const [busy, setBusy] = useState<Record<string, string>>({});

  const refresh = () => void invoke<ServerStatus[]>("lsp_server_status").then(setServers).catch(() => {});
  useEffect(() => { refresh(); }, []);
  useEffect(() => {
    const uns = servers.map((s) =>
      listen<{ phase: string }>(`lsp-install-${s.server_id}`, (e) => {
        setBusy((b) => ({ ...b, [s.server_id]: e.payload.phase }));
        if (e.payload.phase === "done") { setBusy((b) => { const n = { ...b }; delete n[s.server_id]; return n; }); refresh(); }
      }),
    );
    return () => { void Promise.all(uns).then((fns) => fns.forEach((f) => f())); };
  }, [servers]);

  const install = (id: string) => { setBusy((b) => ({ ...b, [id]: "download" })); void invoke("lsp_ensure_server", { serverId: id }).then(refresh).catch(() => setBusy((b) => { const n = { ...b }; delete n[id]; return n; })); };
  const remove = (id: string) => void invoke("lsp_remove_server", { serverId: id }).then(refresh).catch(() => {});

  return (
    <div className="flex flex-col gap-2">
      {servers.map((s) => (
        <div key={s.server_id} className="flex items-center justify-between gap-4 rounded-md border border-border px-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">{s.label}</p>
            <p className="text-xs text-muted-foreground mt-0.5">.{s.languages.join(", .")}</p>
          </div>
          <div className="shrink-0 text-xs">
            {busy[s.server_id] ? (
              <span className="text-muted-foreground">Installing… ({busy[s.server_id]})</span>
            ) : s.state === "builtin" ? (
              <span className="rounded border border-border px-2 py-1 text-muted-foreground">Built-in</span>
            ) : s.state === "installed" ? (
              <button className="rounded border border-border px-2.5 py-1 hover:bg-accent" onClick={() => remove(s.server_id)}>Remove</button>
            ) : (
              <button className="rounded border border-border px-2.5 py-1 hover:bg-accent" onClick={() => install(s.server_id)}>Install</button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Mount it in settings-view.tsx**

Add a "Language Servers" category to the sidebar list and render `<LanguageServersSection />` under an `<h2>Language Servers</h2>` in its content branch, following the existing section pattern (the `<h2 className="mb-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">` + content `<div>` used by other sections). Import `LanguageServersSection` from `./language-servers-section`.

- [ ] **Step 3: Typecheck + manual smoke**

Run: `npm run typecheck 2>&1 | grep -E "language-servers|settings-view"` → no new errors.
Manual: `npm run tauri:dev`, open Settings → Language Servers; rows render with correct state; Install downloads (progress shows); Remove clears.

- [ ] **Step 4: Commit**

```bash
git add src/components/editor/language-servers-section.tsx src/components/editor/settings-view.tsx
git commit -m "feat(lsp): Settings Language Servers panel (status + install/remove)"
```

---

## Task 12: Per-language parity integration tests

**Files:**
- Create: `src/lib/lsp/multilang.integration.test.ts`

**Interfaces:**
- Consumes: `LspClient(serverId)`; spawns each real server via a Node child-process transport (bypassing Tauri), against a tiny fixture.

- [ ] **Step 1: Write parity tests (skipIf server/toolchain absent)**

Create `src/lib/lsp/multilang.integration.test.ts`. It reuses the child-process `Transport` + `framesJS` helpers from `lsp.integration.test.ts` (copy them in — they're test-local). A `spec` table lists per-language `{ serverId, cmd, args, ext, source, expect }`; each row runs the same harness. Python's server is bundled (node + pyright); rust/go/cpp resolve from the cache (`~/.config/maincode/servers/<id>/…`). Each row `describe.skipIf`s when its binary is absent, so CI stays green.

```ts
import { existsSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { LspClient } from "./client";
import type { Transport } from "./transport";

function framesJS(buf: Buffer): { messages: string[]; rest: Buffer } {
  const out: string[] = [];
  let b = buf;
  for (;;) {
    const sep = b.indexOf("\r\n\r\n");
    if (sep === -1) break;
    const m = /content-length:\s*(\d+)/i.exec(b.subarray(0, sep).toString("utf8"));
    if (!m) { b = b.subarray(sep + 4); continue; }
    const len = Number(m[1]); const start = sep + 4;
    if (b.length < start + len) break;
    out.push(b.subarray(start, start + len).toString("utf8"));
    b = b.subarray(start + len);
  }
  return { messages: out, rest: b };
}
function nodeTransport(cmd: string, args: string[], cwd: string): { transport: Transport; kill: () => void } {
  const child = spawn(cmd, args, { cwd });
  const cbs = new Set<(m: string) => void>();
  let carry = Buffer.alloc(0);
  child.stdout.on("data", (chunk: Buffer) => { carry = Buffer.concat([carry, chunk]); const r = framesJS(carry); carry = r.rest; r.messages.forEach((m) => cbs.forEach((cb) => cb(m))); });
  const transport: Transport = {
    send: async (m) => { child.stdin.write(`Content-Length: ${Buffer.byteLength(m)}\r\n\r\n${m}`); },
    onMessage(cb) { cbs.add(cb); return () => cbs.delete(cb); },
    onExit() { return () => {}; },
    dispose() { child.kill(); },
  };
  return { transport, kill: () => child.kill() };
}

const CACHE = join(homedir(), ".config", "maincode", "servers");
const NODE = `${process.cwd()}/resources/lsp/node`;
const spec = [
  {
    serverId: "python",
    cmd: NODE,
    args: [`${process.cwd()}/resources/lsp/server/node_modules/pyright/langserver.index.js`, "--stdio"],
    file: "a.py",
    source: "x: int = undefined_name\n",
    expect: /undefined_name|is not defined|reportUndefinedVariable/,
  },
  {
    serverId: "rust",
    cmd: join(CACHE, "rust", "rust-analyzer"),
    args: [],
    file: "src/main.rs",
    source: "fn main() { let x: i32 = ; }\n",
    expect: /expected expression|syntax/i,
    extra: (dir: string) => writeFileSync(join(dir, "Cargo.toml"), '[package]\nname="t"\nversion="0.1.0"\nedition="2021"\n'),
  },
];

for (const s of spec) {
  const present = existsSync(s.cmd);
  describe.skipIf(!present)(`LSP parity: ${s.serverId}`, () => {
    it("returns diagnostics for a broken file", async () => {
      const dir = mkdtempSync(join(tmpdir(), `lsp-${s.serverId}-`));
      s.extra?.(dir);
      const file = join(dir, s.file);
      const fp = join(dir, s.file.includes("/") ? s.file.split("/")[0] : "");
      if (s.file.includes("/")) { const { mkdirSync } = await import("node:fs"); mkdirSync(fp, { recursive: true }); }
      writeFileSync(file, s.source);
      const t = nodeTransport(s.cmd, s.args, dir);
      const c = new LspClient(s.serverId, async () => ({ id: 1, transport: t.transport }));
      await c.openProject(dir);
      c.notifyDocOpened(file, readFileSync(file, "utf8"));
      await new Promise((r) => setTimeout(r, 12000)); // servers take a few s to analyze
      const diags = await c.getDiagnostics(file);
      c.closeProject();
      t.kill();
      expect(diags.map((d) => d.message).join("\n")).toMatch(s.expect);
    }, 40_000);
  });
}
```

(Add `go` and `cpp` rows to `spec` the same way once their fixtures are settled: gopls needs a `go.mod` (`extra`), clangd needs a `.cpp` with a syntax error and resolves from `join(CACHE, "cpp", "clangd_18.1.3", "bin", "clangd")`.)

- [ ] **Step 2: Run (locally, where servers are installed)**

Run: `npm test`
Expected: the parity blocks pass for installed servers, skip for absent ones; the rest of the suite stays green.

- [ ] **Step 3: Commit**

```bash
git add src/lib/lsp/multilang.integration.test.ts
git commit -m "test(lsp): per-language parity integration tests"
```

---

## Self-review notes

- **Spec coverage:** generalized spawn+registry (T1), client+doc-buffer (T2), manager+routing (T3), acquire module (T4), ensure+cache+progress (T5), pyright (T6), rust-analyzer (T7), clangd (T8), gopls (T9), status/remove commands (T10), Settings panel (T11), parity tests (T12). Login-shell PATH (T1). Runtime-toolchain caveats surfaced via error messages (T9 "install Go", per-client degrade).
- **Deferred (noted, not gaps):** checksum verification of downloads (size sanity only for v1); Windows asset matrix (macOS-first); per-server `initializationOptions` tuning.
- **Type consistency:** `serverId: string` threads through `lsp_spawn`/`lsp_ensure_server`/`spawnServer`/`LspClient`/manager; `resolve_command` arms and `resolve_command`-derived `lsp_server_status` presence checks share the same cache paths; `lsp-install-<serverId>` event shape `{ phase }` is consumed identically in T7–T9 (emit) and T11 (listen).
