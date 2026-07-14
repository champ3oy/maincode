# LSP Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the in-browser TypeScript worker with real `tsserver` (fronted by `typescript-language-server`) run as a bundled sidecar and consumed over LSP, behind a settings flag, so monorepo/`@types`/resolution/crash bugs disappear at the root.

**Architecture:** A bundled Node + `typescript-language-server` process per project root. A Rust module (`lsp.rs`, mirroring `pty.rs`) spawns it, parses `Content-Length` LSP frames, and shuttles complete messages over Tauri events/commands. A frontend LSP client (`src/lib/lsp/`) speaks JSON-RPC over that bridge and implements the same `IntelligenceClient` interface the current worker does. A selector (`src/lib/intelligence.ts`) picks worker vs LSP by `settings.editor.engine`, so CodeMirror wiring is engine-agnostic.

**Tech Stack:** Tauri v2 (Rust, `std::process`), `typescript-language-server` v5.3.0 + pinned `typescript`, bundled Node v22, TypeScript, CodeMirror 6, Vitest.

## Global Constraints

- **Runtime:** bundle Node + `typescript-language-server` (+ pinned `typescript`) as Tauri **resources** under `resources/lsp/`; never assume system Node.
- **Server invocation:** `<node> resources/lsp/server/node_modules/typescript-language-server/lib/cli.mjs --stdio`, `cwd = project root`.
- **Transport:** LSP `Content-Length`-framed JSON-RPC over stdio; Rust does the framing and emits one Tauri event per complete message.
- **One server per project root**, refcounted; keyed by absolute root path.
- **Cutover:** new setting `editor.engine: "worker" | "lsp"`, default `"worker"`. Do NOT delete `src/lib/ts-worker/*` in this plan.
- **LSP positions** are 0-based `{line, character}` in UTF-16 code units; CodeMirror uses UTF-16 offsets; `DefinitionResult` line/column are **1-based**.
- **Interface parity:** the LSP client MUST implement `IntelligenceClient` (defined in Task 6) so `cm.ts` is engine-agnostic.
- Follow existing patterns: Rust commands register in `src-tauri/src/lib.rs` via `.manage(...)` + `tauri::generate_handler![...]`; TS tests are Vitest (`npm test`).

---

## File Structure

**Create:**
- `scripts/fetch-lsp.mjs` — build step: download platform Node + install server into `resources/lsp/`.
- `src-tauri/src/lsp.rs` — spawn/frame/pipe the server; `LspState`; commands + frame parser (+ Rust unit tests).
- `src/lib/lsp/protocol.ts` — LSP message types (subset) + position↔offset + uri↔path helpers.
- `src/lib/lsp/protocol.test.ts` — helper unit tests.
- `src/lib/lsp/transport.ts` — `Transport` interface + Tauri bridge (`spawnServer`).
- `src/lib/lsp/client.ts` — JSON-RPC + LSP client implementing `IntelligenceClient`.
- `src/lib/lsp/client.test.ts` — client unit tests with a fake transport.
- `src/lib/intelligence.ts` — `IntelligenceClient` interface + engine selector.
- `src/lib/lsp/lsp.integration.test.ts` — parity test against the real `lugway` project (skips if absent).

**Modify:**
- `src-tauri/tauri.conf.json` — `bundle.resources`.
- `src-tauri/src/lib.rs` — `mod lsp;`, `.manage(lsp::LspState::default())`, register 3 commands.
- `src/hooks/use-settings.tsx` — add `editor.engine`.
- `src/lib/ts-worker/client.ts` — export the `IntelligenceClient` interface shape (or re-export `TsClient` as it).
- `src/lib/ts-worker/cm.ts` — call `intelligenceClient()` instead of `tsClient()`.
- `src/components/editor/code-editor.tsx` — didOpen/didClose wiring; use the selector.

---

## Task 1: Sidecar bundling (fetch script + Tauri resources)

**Files:**
- Create: `scripts/fetch-lsp.mjs`
- Create: `resources/lsp/.gitignore` (ignore downloaded binaries)
- Modify: `src-tauri/tauri.conf.json`
- Modify: `package.json` (add `lsp:fetch` script)

**Interfaces:**
- Produces: on-disk `resources/lsp/node` (executable) and `resources/lsp/server/node_modules/typescript-language-server/lib/cli.mjs`. Rust (Task 3) resolves these via `BaseDirectory::Resource`.

- [ ] **Step 1: Write the fetch script**

Create `scripts/fetch-lsp.mjs`:

```js
// Downloads a platform Node runtime and installs typescript-language-server +
// a pinned typescript into resources/lsp/ so they can be bundled as Tauri
// resources. Idempotent: skips work if the outputs already exist.
import { existsSync, mkdirSync, rmSync, cpSync, chmodSync } from "node:fs";
import { execSync } from "node:child_process";
import { arch, platform } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const NODE_VERSION = "v22.22.1";
const TLS_VERSION = "5.3.0";
const TS_VERSION = "5.9.2";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "resources", "lsp");
const serverDir = join(out, "server");
const nodeBin = join(out, "node");

function plat() {
  const p = platform();
  if (p === "darwin") return { os: "darwin", ext: "tar.gz" };
  if (p === "linux") return { os: "linux", ext: "tar.gz" };
  if (p === "win32") return { os: "win", ext: "zip" };
  throw new Error(`unsupported platform ${p}`);
}
function cpu() {
  const a = arch();
  if (a === "arm64") return "arm64";
  if (a === "x64") return "x64";
  throw new Error(`unsupported arch ${a}`);
}

function fetchNode() {
  if (existsSync(nodeBin)) return;
  const { os, ext } = plat();
  const name = `node-${NODE_VERSION}-${os}-${cpu()}`;
  const url = `https://nodejs.org/dist/${NODE_VERSION}/${name}.${ext}`;
  const tmp = join(out, "node-dl");
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  console.log(`downloading ${url}`);
  execSync(`curl -fsSL ${url} | tar -xz -C ${tmp}`, { stdio: "inherit" });
  cpSync(join(tmp, name, "bin", "node"), nodeBin);
  chmodSync(nodeBin, 0o755);
  rmSync(tmp, { recursive: true, force: true });
}

function installServer() {
  const cli = join(serverDir, "node_modules", "typescript-language-server", "lib", "cli.mjs");
  if (existsSync(cli)) return;
  mkdirSync(serverDir, { recursive: true });
  execSync(
    `npm init -y && npm install --omit=dev typescript-language-server@${TLS_VERSION} typescript@${TS_VERSION}`,
    { cwd: serverDir, stdio: "inherit" },
  );
}

mkdirSync(out, { recursive: true });
fetchNode();
installServer();
console.log("LSP sidecar ready at resources/lsp/");
```

- [ ] **Step 2: Add npm script + gitignore**

In `package.json` `"scripts"`, add:

```json
"lsp:fetch": "node scripts/fetch-lsp.mjs"
```

Create `resources/lsp/.gitignore`:

```
node
node-dl/
server/
```

- [ ] **Step 3: Wire Tauri resources**

In `src-tauri/tauri.conf.json`, under `"bundle"`, add (create the `resources` key):

```json
"resources": ["../resources/lsp/**/*"]
```

- [ ] **Step 4: Run the fetch and verify outputs**

Run: `npm run lsp:fetch`
Expected: prints "LSP sidecar ready", then:

Run: `./resources/lsp/node --version && ls resources/lsp/server/node_modules/typescript-language-server/lib/cli.mjs`
Expected: `v22.22.1` and the cli.mjs path listed.

- [ ] **Step 5: Smoke-test the server starts and speaks LSP**

Run:
```bash
printf 'Content-Length: 58\r\n\r\n{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
| ./resources/lsp/node resources/lsp/server/node_modules/typescript-language-server/lib/cli.mjs --stdio | head -c 200
```
Expected: a `Content-Length:` framed JSON response containing `"capabilities"`.

- [ ] **Step 6: Commit**

```bash
git add scripts/fetch-lsp.mjs package.json resources/lsp/.gitignore src-tauri/tauri.conf.json
git commit -m "build: bundle Node + typescript-language-server as LSP sidecar resources"
```

---

## Task 2: Rust LSP frame parser (pure, unit-tested)

**Files:**
- Create: `src-tauri/src/lsp.rs` (parser + tests only in this task)

**Interfaces:**
- Produces: `pub fn parse_frames(buf: &mut Vec<u8>) -> Vec<String>` — drains every complete `Content-Length`-framed message from `buf`, returns their JSON bodies as `String`s, and leaves any partial trailing frame in `buf`.

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/lsp.rs`:

```rust
/// Drain every complete LSP message (`Content-Length: N\r\n\r\n<N bytes>`) from
/// `buf`, returning the JSON bodies. A partial trailing frame stays in `buf` for
/// the next read. Framing is done in bytes so multibyte UTF-8 split across reads
/// is handled correctly.
pub fn parse_frames(buf: &mut Vec<u8>) -> Vec<String> {
    let mut out = Vec::new();
    loop {
        // Find header/body separator.
        let Some(sep) = find_subslice(buf, b"\r\n\r\n") else { break };
        let header = &buf[..sep];
        let Some(len) = content_length(header) else {
            // Malformed header: drop up to and including the separator, continue.
            buf.drain(..sep + 4);
            continue;
        };
        let body_start = sep + 4;
        if buf.len() < body_start + len {
            break; // body not fully arrived yet
        }
        let body = buf[body_start..body_start + len].to_vec();
        buf.drain(..body_start + len);
        if let Ok(s) = String::from_utf8(body) {
            out.push(s);
        }
    }
    out
}

fn find_subslice(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

fn content_length(header: &[u8]) -> Option<usize> {
    let text = std::str::from_utf8(header).ok()?;
    for line in text.split("\r\n") {
        if let Some(rest) = line
            .to_ascii_lowercase()
            .strip_prefix("content-length:")
        {
            return rest.trim().parse::<usize>().ok();
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(body: &str) -> Vec<u8> {
        format!("Content-Length: {}\r\n\r\n{}", body.len(), body).into_bytes()
    }

    #[test]
    fn parses_single_frame() {
        let mut buf = frame("{\"a\":1}");
        assert_eq!(parse_frames(&mut buf), vec!["{\"a\":1}".to_string()]);
        assert!(buf.is_empty());
    }

    #[test]
    fn parses_multiple_frames_in_one_read() {
        let mut buf = frame("{\"a\":1}");
        buf.extend(frame("{\"b\":2}"));
        assert_eq!(
            parse_frames(&mut buf),
            vec!["{\"a\":1}".to_string(), "{\"b\":2}".to_string()]
        );
    }

    #[test]
    fn keeps_partial_frame_until_body_arrives() {
        let full = frame("{\"hi\":true}");
        let mut buf = full[..full.len() - 3].to_vec(); // missing last 3 bytes
        assert_eq!(parse_frames(&mut buf), Vec::<String>::new());
        buf.extend_from_slice(&full[full.len() - 3..]);
        assert_eq!(parse_frames(&mut buf), vec!["{\"hi\":true}".to_string()]);
    }

    #[test]
    fn handles_multibyte_body_split_across_reads() {
        let body = "{\"s\":\"café→\"}"; // multibyte UTF-8
        let full = frame(body);
        let cut = full.len() - 2; // split inside a multibyte sequence
        let mut buf = full[..cut].to_vec();
        assert!(parse_frames(&mut buf).is_empty());
        buf.extend_from_slice(&full[cut..]);
        assert_eq!(parse_frames(&mut buf), vec![body.to_string()]);
    }
}
```

- [ ] **Step 2: Register the module so it compiles**

In `src-tauri/src/lib.rs`, add after line 5 (`mod pty;`):

```rust
mod lsp;
```

- [ ] **Step 3: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test lsp::tests`
Expected: 4 tests pass (`parses_single_frame`, `parses_multiple_frames_in_one_read`, `keeps_partial_frame_until_body_arrives`, `handles_multibyte_body_split_across_reads`).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/lsp.rs src-tauri/src/lib.rs
git commit -m "feat(lsp): Content-Length frame parser with tests"
```

---

## Task 3: Rust spawn/pipe + commands + state

**Files:**
- Modify: `src-tauri/src/lsp.rs` (add spawn/state/commands above the `#[cfg(test)]` block)
- Modify: `src-tauri/src/lib.rs` (manage state + register commands)

**Interfaces:**
- Consumes: `parse_frames` (Task 2).
- Produces (Tauri commands, callable from JS via `invoke`):
  - `lsp_spawn(root: String) -> Result<u32, String>` — spawns/reuses a server for `root`, returns its session id.
  - `lsp_send(id: u32, message: String) -> Result<(), String>` — writes one `Content-Length`-framed message to the server's stdin.
  - `lsp_stop(id: u32) -> Result<(), String>` — refcount--; kills on zero.
  - Events per session: `lsp-msg-<id>` (payload: one JSON message string), `lsp-exit-<id>` (payload: `()`).

- [ ] **Step 1: Add imports + state + spawn/send/stop**

At the TOP of `src-tauri/src/lsp.rs` (above `parse_frames`), add:

```rust
use std::collections::HashMap;
use std::io::Write;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

struct LspSession {
    child: Child,
    stdin: ChildStdin,
    root: String,
    refcount: u32,
}

pub struct LspState {
    sessions: Mutex<HashMap<u32, LspSession>>,
    by_root: Mutex<HashMap<String, u32>>,
    next_id: AtomicU32,
}

impl Default for LspState {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            by_root: Mutex::new(HashMap::new()),
            next_id: AtomicU32::new(1),
        }
    }
}

fn resource(app: &AppHandle, rel: &str) -> Result<std::path::PathBuf, String> {
    app.path()
        .resolve(rel, tauri::path::BaseDirectory::Resource)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn lsp_spawn(root: String, app: AppHandle, state: State<LspState>) -> Result<u32, String> {
    // Reuse an existing server for this root (refcount++).
    {
        let by_root = state.by_root.lock().map_err(|e| e.to_string())?;
        if let Some(&id) = by_root.get(&root) {
            let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
            if let Some(s) = sessions.get_mut(&id) {
                s.refcount += 1;
                return Ok(id);
            }
        }
    }

    let node = resource(&app, "lsp/node")?;
    let cli = resource(
        &app,
        "lsp/server/node_modules/typescript-language-server/lib/cli.mjs",
    )?;

    let mut child = Command::new(node)
        .arg(cli)
        .arg("--stdio")
        .current_dir(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("failed to spawn LSP server: {e}"))?;

    let stdin = child.stdin.take().ok_or("no stdin")?;
    let mut stdout = child.stdout.take().ok_or("no stdout")?;
    let id = state.next_id.fetch_add(1, Ordering::SeqCst);

    // Reader thread: accumulate bytes, drain complete frames, emit each.
    let app_out = app.clone();
    std::thread::spawn(move || {
        use std::io::Read;
        let mut carry: Vec<u8> = Vec::new();
        let mut buf = [0u8; 8192];
        loop {
            match stdout.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    carry.extend_from_slice(&buf[..n]);
                    for msg in parse_frames(&mut carry) {
                        let _ = app_out.emit(&format!("lsp-msg-{id}"), msg);
                    }
                }
            }
        }
        let _ = app_out.emit(&format!("lsp-exit-{id}"), ());
    });

    state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id, LspSession { child, stdin, root: root.clone(), refcount: 1 });
    state
        .by_root
        .lock()
        .map_err(|e| e.to_string())?
        .insert(root, id);
    Ok(id)
}

#[tauri::command]
pub fn lsp_send(id: u32, message: String, state: State<LspState>) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let s = sessions.get_mut(&id).ok_or("no such LSP session")?;
    let framed = format!("Content-Length: {}\r\n\r\n{}", message.len(), message);
    s.stdin.write_all(framed.as_bytes()).map_err(|e| e.to_string())?;
    s.stdin.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn lsp_stop(id: u32, state: State<LspState>) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let Some(s) = sessions.get_mut(&id) else { return Ok(()) };
    s.refcount = s.refcount.saturating_sub(1);
    if s.refcount == 0 {
        let root = s.root.clone();
        let mut s = sessions.remove(&id).unwrap();
        let _ = s.child.kill();
        state.by_root.lock().map_err(|e| e.to_string())?.remove(&root);
    }
    Ok(())
}
```

> Note: `message.len()` is the UTF-8 byte length in Rust (String is UTF-8), which is exactly what `Content-Length` requires.

- [ ] **Step 2: Register state + commands**

In `src-tauri/src/lib.rs`, after line 70 (`.manage(pty::PtyState::default())`), add:

```rust
        .manage(lsp::LspState::default())
```

Inside `tauri::generate_handler![...]` (after the `pty::` entries, ~line 98), add:

```rust
            lsp::lsp_spawn,
            lsp::lsp_send,
            lsp::lsp_stop,
```

- [ ] **Step 3: Verify it compiles**

Run: `cd src-tauri && cargo build`
Expected: builds with no errors (warnings about `Manager` import only if unused elsewhere are fine).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/lsp.rs src-tauri/src/lib.rs
git commit -m "feat(lsp): spawn/pipe server per root + lsp_spawn/send/stop commands"
```

---

## Task 4: LSP protocol helpers (positions, URIs, types)

**Files:**
- Create: `src/lib/lsp/protocol.ts`
- Create: `src/lib/lsp/protocol.test.ts`

**Interfaces:**
- Produces:
  - `offsetToPosition(text: string, offset: number): { line: number; character: number }` — 0-based, UTF-16.
  - `positionToOffset(text: string, pos: { line: number; character: number }): number`.
  - `pathToUri(path: string): string` and `uriToPath(uri: string): string`.
  - Types: `LspPosition`, `LspRange`, `LspDiagnostic`, `LspHover`, `LspLocation`, `LspCompletionItem`.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/lsp/protocol.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { offsetToPosition, positionToOffset, pathToUri, uriToPath } from "./protocol";

const doc = "abc\ndef\nghij"; // line0 len3, line1 len3, line2 len4

describe("offsetToPosition", () => {
  it("maps offsets to 0-based line/character", () => {
    expect(offsetToPosition(doc, 0)).toEqual({ line: 0, character: 0 });
    expect(offsetToPosition(doc, 5)).toEqual({ line: 1, character: 1 }); // 'e'
    expect(offsetToPosition(doc, 8)).toEqual({ line: 2, character: 0 }); // 'g'
  });
});

describe("positionToOffset", () => {
  it("is the inverse of offsetToPosition", () => {
    for (const off of [0, 3, 4, 5, 8, 12]) {
      expect(positionToOffset(doc, offsetToPosition(doc, off))).toBe(off);
    }
  });
  it("clamps a character past line end to the line end", () => {
    expect(positionToOffset(doc, { line: 0, character: 99 })).toBe(3);
  });
});

describe("uri <-> path", () => {
  it("round-trips absolute paths with spaces", () => {
    const p = "/Users/a b/c/main.ts";
    expect(uriToPath(pathToUri(p))).toBe(p);
    expect(pathToUri(p)).toMatch(/^file:\/\//);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/lsp/protocol.test.ts`
Expected: FAIL ("Cannot find module './protocol'").

- [ ] **Step 3: Implement `protocol.ts`**

Create `src/lib/lsp/protocol.ts`:

```ts
// LSP position/URI helpers + the message-type subset we use. LSP positions are
// 0-based {line, character} in UTF-16 code units; JS strings are UTF-16, so a
// character is a plain string index within its line.

export interface LspPosition { line: number; character: number }
export interface LspRange { start: LspPosition; end: LspPosition }
export interface LspDiagnostic {
  range: LspRange;
  severity?: 1 | 2 | 3 | 4; // Error | Warning | Information | Hint
  message: string;
}
export interface LspLocation { uri: string; range: LspRange }
export interface LspHover {
  contents: string | { value: string } | { kind: string; value: string } | Array<string | { value: string }>;
  range?: LspRange;
}
export interface LspCompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  sortText?: string;
  insertText?: string;
  textEdit?: { range: LspRange; newText: string };
  additionalTextEdits?: { range: LspRange; newText: string }[];
  data?: unknown;
}

/** 0-based {line, character} for a UTF-16 offset into `text`. */
export function offsetToPosition(text: string, offset: number): LspPosition {
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, character: offset - lineStart };
}

/** UTF-16 offset for a 0-based {line, character}; clamps to line/doc bounds. */
export function positionToOffset(text: string, pos: LspPosition): number {
  let offset = 0;
  let line = 0;
  while (line < pos.line) {
    const nl = text.indexOf("\n", offset);
    if (nl === -1) return text.length;
    offset = nl + 1;
    line++;
  }
  const lineEnd = text.indexOf("\n", offset);
  const maxChar = (lineEnd === -1 ? text.length : lineEnd) - offset;
  return offset + Math.min(pos.character, maxChar);
}

export function pathToUri(path: string): string {
  const enc = path
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  return `file://${enc}`;
}

export function uriToPath(uri: string): string {
  return decodeURIComponent(uri.replace(/^file:\/\//, ""));
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/lib/lsp/protocol.test.ts`
Expected: PASS (all 3 describe blocks).

- [ ] **Step 5: Commit**

```bash
git add src/lib/lsp/protocol.ts src/lib/lsp/protocol.test.ts
git commit -m "feat(lsp): position/uri helpers + protocol types"
```

---

## Task 5: Transport (Tauri bridge behind an injectable interface)

**Files:**
- Create: `src/lib/lsp/transport.ts`

**Interfaces:**
- Produces:
  - `interface Transport { send(message: string): Promise<void>; onMessage(cb: (m: string) => void): () => void; onExit(cb: () => void): () => void; dispose(): void }`
  - `spawnServer(root: string): Promise<{ id: number; transport: Transport }>` — real Tauri implementation.

- [ ] **Step 1: Implement transport**

Create `src/lib/lsp/transport.ts`:

```ts
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** A raw JSON-message pipe to one LSP server session. */
export interface Transport {
  send(message: string): Promise<void>;
  onMessage(cb: (message: string) => void): () => void;
  onExit(cb: () => void): () => void;
  dispose(): void;
}

/** Spawn a server for `root` and return a Transport bound to its session id. */
export async function spawnServer(root: string): Promise<{ id: number; transport: Transport }> {
  const id = await invoke<number>("lsp_spawn", { root });
  const msgListeners = new Set<(m: string) => void>();
  const exitListeners = new Set<() => void>();
  const unlisten: UnlistenFn[] = [];

  void listen<string>(`lsp-msg-${id}`, (e) => msgListeners.forEach((cb) => cb(e.payload))).then(
    (u) => unlisten.push(u),
  );
  void listen(`lsp-exit-${id}`, () => exitListeners.forEach((cb) => cb())).then((u) =>
    unlisten.push(u),
  );

  const transport: Transport = {
    send: (message) => invoke("lsp_send", { id, message }),
    onMessage(cb) {
      msgListeners.add(cb);
      return () => msgListeners.delete(cb);
    },
    onExit(cb) {
      exitListeners.add(cb);
      return () => exitListeners.delete(cb);
    },
    dispose() {
      unlisten.forEach((u) => u());
      void invoke("lsp_stop", { id }).catch(() => {});
    },
  };
  return { id, transport };
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `npm run typecheck 2>&1 | grep -c "src/lib/lsp/transport"`
Expected: `0` (no new errors in this file).

- [ ] **Step 3: Commit**

```bash
git add src/lib/lsp/transport.ts
git commit -m "feat(lsp): Tauri transport bridge (spawnServer + Transport)"
```

---

## Task 6: LSP client implementing `IntelligenceClient`

**Files:**
- Create: `src/lib/intelligence.ts` (interface only in this task; selector added in Task 7)
- Create: `src/lib/lsp/client.ts`
- Create: `src/lib/lsp/client.test.ts`

**Interfaces:**
- Consumes: `Transport` (Task 5); `protocol.ts` helpers/types (Task 4); `CompletionItemData`, `DiagnosticData`, `HoverResult`, `DefinitionResult`, `CompletionsResult`, `DetailsResult` from `src/lib/ts-worker/protocol.ts`.
- Produces:
  - `IntelligenceClient` interface (in `src/lib/intelligence.ts`).
  - `class LspClient implements IntelligenceClient` with a constructor taking a `spawn` function `(root: string) => Promise<{ id: number; transport: Transport }>` (defaults to `spawnServer`) so tests inject a fake.

- [ ] **Step 1: Define the shared interface**

Create `src/lib/intelligence.ts`:

```ts
import type {
  CompletionItemData,
  CompletionsResult,
  DetailsResult,
  DiagnosticData,
  DefinitionResult,
  HoverResult,
} from "./ts-worker/protocol";

/** The contract both the in-browser worker and the LSP client implement, so the
 *  CodeMirror layer is engine-agnostic. Offsets are UTF-16 doc offsets. */
export interface IntelligenceClient {
  openProject(root: string): Promise<void>;
  closeProject(): void;
  ready(): boolean;
  /** File became visible in the editor (LSP didOpen; worker: load into VFS). */
  notifyDocOpened(path: string, content: string): void;
  /** File content changed (LSP didChange; worker: docChanged). */
  notifyDocChanged(path: string, content: string): void;
  /** File/tab closed (LSP didClose; worker: no-op). */
  notifyDocClosed(path: string): void;
  getCompletions(path: string, offset: number): Promise<CompletionsResult | null>;
  getCompletionDetails(
    path: string,
    offset: number,
    item: CompletionItemData,
  ): Promise<DetailsResult | null>;
  getDiagnostics(path: string): Promise<DiagnosticData[]>;
  getHover(path: string, offset: number): Promise<HoverResult | null>;
  getDefinition(path: string, offset: number): Promise<DefinitionResult | null>;
  /** Fires when pushed diagnostics arrive so the editor re-lints. */
  onTypesUpdated(fn: () => void): () => void;
}
```

- [ ] **Step 2: Write the failing client tests**

Create `src/lib/lsp/client.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { LspClient } from "./client";
import type { Transport } from "./transport";

// A fake transport that records outgoing messages and lets the test push replies.
function makeFake() {
  const sent: any[] = [];
  let onMsg: ((m: string) => void) | null = null;
  const push = (obj: unknown) => onMsg?.(JSON.stringify(obj));
  const transport: Transport = {
    send: async (m) => {
      const msg = JSON.parse(m);
      sent.push(msg);
      // Auto-reply to initialize immediately so openProject resolves without
      // fragile microtask timing in the test.
      if (msg.method === "initialize") {
        push({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {} } });
      }
    },
    onMessage(cb) {
      onMsg = cb;
      return () => {};
    },
    onExit() {
      return () => {};
    },
    dispose() {},
  };
  return { sent, push, transport };
}

function client(fake: ReturnType<typeof makeFake>) {
  return new LspClient(async () => ({ id: 1, transport: fake.transport }));
}

describe("LspClient", () => {
  it("initializes and reports ready", async () => {
    const fake = makeFake();
    const c = client(fake);
    await c.openProject("/repo");
    expect(c.ready()).toBe(true);
    expect(fake.sent[0].method).toBe("initialize");
    expect(fake.sent.find((m) => m.method === "initialized")).toBeTruthy();
  });

  it("maps pushed publishDiagnostics to DiagnosticData offsets", async () => {
    const fake = makeFake();
    const c = client(fake);
    await c.openProject("/repo");
    c.notifyDocOpened("/repo/a.ts", "const x = 1;\nlet y = 2;\n");
    const fired = vi.fn();
    c.onTypesUpdated(fired);
    fake.push({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri: "file:///repo/a.ts",
        diagnostics: [
          { range: { start: { line: 1, character: 4 }, end: { line: 1, character: 5 } }, severity: 1, message: "bad y" },
        ],
      },
    });
    expect(fired).toHaveBeenCalled();
    // doc: "const x = 1;\nlet y = 2;\n" — line 1 starts at offset 13, so
    // {line:1,character:4}→17 ('y'), {line:1,character:5}→18.
    const diags = await c.getDiagnostics("/repo/a.ts");
    expect(diags).toEqual([{ from: 17, to: 18, severity: "error", message: "bad y" }]);
  });

  it("resolves getDefinition to a 1-based path/line/column", async () => {
    const fake = makeFake();
    const c = client(fake);
    await c.openProject("/repo");
    c.notifyDocOpened("/repo/a.ts", "import x from './b';\n");
    const p = c.getDefinition("/repo/a.ts", 7);
    await Promise.resolve();
    const req = fake.sent.find((m) => m.method === "textDocument/definition");
    fake.push({
      jsonrpc: "2.0",
      id: req.id,
      result: [{ uri: "file:///repo/b.ts", range: { start: { line: 4, character: 2 }, end: { line: 4, character: 8 } } }],
    });
    expect(await p).toEqual({ path: "/repo/b.ts", line: 5, column: 3 });
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run src/lib/lsp/client.test.ts`
Expected: FAIL ("Cannot find module './client'").

- [ ] **Step 4: Implement the client**

Create `src/lib/lsp/client.ts`:

```ts
import type {
  CompletionItemData,
  CompletionsResult,
  DetailsResult,
  DiagnosticData,
  DefinitionResult,
  HoverResult,
} from "../ts-worker/protocol";
import type { IntelligenceClient } from "../intelligence";
import { spawnServer, type Transport } from "./transport";
import {
  offsetToPosition,
  positionToOffset,
  pathToUri,
  uriToPath,
  type LspCompletionItem,
  type LspDiagnostic,
  type LspHover,
  type LspLocation,
} from "./protocol";

type Spawn = (root: string) => Promise<{ id: number; transport: Transport }>;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

const SEVERITY: Record<number, DiagnosticData["severity"]> = { 1: "error", 2: "warning", 3: "info", 4: "info" };

export class LspClient implements IntelligenceClient {
  private transport: Transport | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly docs = new Map<string, string>(); // path -> current text
  private readonly diagnostics = new Map<string, LspDiagnostic[]>(); // uri -> diags
  private readonly typesListeners = new Set<() => void>();
  private isReady = false;
  private root = "";

  constructor(private readonly spawn: Spawn = spawnServer) {}

  async openProject(root: string): Promise<void> {
    this.closeProject();
    this.root = root;
    const { transport } = await this.spawn(root);
    this.transport = transport;
    transport.onMessage((m) => this.onMessage(m));
    transport.onExit(() => (this.isReady = false));
    await this.request("initialize", {
      processId: null,
      rootUri: pathToUri(root),
      capabilities: {
        textDocument: {
          synchronization: { didSave: false },
          completion: { completionItem: { snippetSupport: false } },
          hover: { contentFormat: ["markdown", "plaintext"] },
          definition: {},
          publishDiagnostics: {},
        },
      },
      workspaceFolders: [{ uri: pathToUri(root), name: root }],
    });
    this.notify("initialized", {});
    this.isReady = true;
  }

  closeProject(): void {
    this.isReady = false;
    this.pending.clear();
    this.docs.clear();
    this.diagnostics.clear();
    this.transport?.dispose();
    this.transport = null;
  }

  ready(): boolean {
    return this.isReady;
  }

  notifyDocOpened(path: string, content: string): void {
    if (!this.isReady) return;
    this.docs.set(path, content);
    this.notify("textDocument/didOpen", {
      textDocument: { uri: pathToUri(path), languageId: languageId(path), version: 1, text: content },
    });
  }

  notifyDocChanged(path: string, content: string): void {
    if (!this.isReady) return;
    this.docs.set(path, content);
    this.notify("textDocument/didChange", {
      textDocument: { uri: pathToUri(path), version: Date.now() },
      contentChanges: [{ text: content }], // full-document sync
    });
  }

  notifyDocClosed(path: string): void {
    if (!this.isReady) return;
    this.docs.delete(path);
    this.notify("textDocument/didClose", { textDocument: { uri: pathToUri(path) } });
  }

  async getDiagnostics(path: string): Promise<DiagnosticData[]> {
    const text = this.docs.get(path);
    const diags = this.diagnostics.get(pathToUri(path));
    if (!text || !diags) return [];
    return diags.map((d) => ({
      from: positionToOffset(text, d.range.start),
      to: positionToOffset(text, d.range.end),
      severity: SEVERITY[d.severity ?? 1] ?? "error",
      message: d.message,
    }));
  }

  async getHover(path: string, offset: number): Promise<HoverResult | null> {
    const text = this.docs.get(path);
    if (!this.isReady || !text) return null;
    const res = (await this.request("textDocument/hover", {
      textDocument: { uri: pathToUri(path) },
      position: offsetToPosition(text, offset),
    }).catch(() => null)) as LspHover | null;
    if (!res || !res.contents) return null;
    const md = hoverToMarkdown(res.contents);
    if (!md) return null;
    return { signature: [{ text: md, kind: "text" }], documentation: "", tags: [] };
  }

  async getDefinition(path: string, offset: number): Promise<DefinitionResult | null> {
    const text = this.docs.get(path);
    if (!this.isReady || !text) return null;
    const res = (await this.request("textDocument/definition", {
      textDocument: { uri: pathToUri(path) },
      position: offsetToPosition(text, offset),
    }).catch(() => null)) as LspLocation | LspLocation[] | null;
    const loc = Array.isArray(res) ? res[0] : res;
    if (!loc) return null;
    return {
      path: uriToPath(loc.uri),
      line: loc.range.start.line + 1,
      column: loc.range.start.character + 1,
    };
  }

  async getCompletions(path: string, offset: number): Promise<CompletionsResult | null> {
    const text = this.docs.get(path);
    if (!this.isReady || !text) return null;
    const res = (await this.request("textDocument/completion", {
      textDocument: { uri: pathToUri(path) },
      position: offsetToPosition(text, offset),
    }).catch(() => null)) as { items?: LspCompletionItem[] } | LspCompletionItem[] | null;
    const items = Array.isArray(res) ? res : res?.items;
    if (!items || items.length === 0) return null;
    return {
      fromOffset: offset,
      items: items.slice(0, 300).map((i) => ({
        label: i.label,
        kind: String(i.kind ?? ""),
        detail: i.detail,
        sortText: i.sortText ?? "",
        insertText: i.insertText ?? i.textEdit?.newText,
        source: undefined,
        data: i.data,
      })),
    } as CompletionsResult;
  }

  async getCompletionDetails(
    _path: string,
    _offset: number,
    _item: CompletionItemData,
  ): Promise<DetailsResult | null> {
    // v1: no server-side resolve wiring yet; auto-import edits arrive with the
    // completion item itself (additionalTextEdits) in a follow-up.
    return { extraChanges: [] };
  }

  onTypesUpdated(fn: () => void): () => void {
    this.typesListeners.add(fn);
    return () => this.typesListeners.delete(fn);
  }

  // ---- JSON-RPC plumbing ----
  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      void this.transport?.send(payload).catch((e) => {
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      });
    });
  }

  private notify(method: string, params: unknown): void {
    void this.transport?.send(JSON.stringify({ jsonrpc: "2.0", method, params })).catch(() => {});
  }

  private onMessage(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? "LSP error"));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === "textDocument/publishDiagnostics") {
      this.diagnostics.set(msg.params.uri, msg.params.diagnostics ?? []);
      this.typesListeners.forEach((fn) => fn());
    }
    // Server→client requests (e.g. registerCapability) get a null result so the
    // server isn't left waiting.
    if (msg.id !== undefined && msg.method) {
      void this.transport?.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: null }));
    }
  }
}

function languageId(path: string): string {
  if (path.endsWith(".tsx")) return "typescriptreact";
  if (path.endsWith(".jsx")) return "javascriptreact";
  if (path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".cjs")) return "javascript";
  return "typescript";
}

function hoverToMarkdown(contents: LspHover["contents"]): string {
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) return contents.map((c) => (typeof c === "string" ? c : c.value)).join("\n\n");
  return (contents as { value: string }).value ?? "";
}
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run src/lib/lsp/client.test.ts`
Expected: PASS (3 tests: initializes, maps diagnostics, resolves definition).

- [ ] **Step 6: Commit**

```bash
git add src/lib/intelligence.ts src/lib/lsp/client.ts src/lib/lsp/client.test.ts
git commit -m "feat(lsp): LSP client implementing IntelligenceClient (diagnostics/hover/definition/completion)"
```

---

## Task 7: Engine selector + `editor.engine` setting

**Files:**
- Modify: `src/lib/intelligence.ts` (add selector)
- Modify: `src/lib/ts-worker/client.ts` (make `tsClient()` satisfy `IntelligenceClient`)
- Modify: `src/hooks/use-settings.tsx`
- Modify: `src/hooks/use-settings.test.ts`

**Interfaces:**
- Consumes: `LspClient` (Task 6); `tsClient()` (existing).
- Produces: `intelligenceClient(engine: "worker" | "lsp"): IntelligenceClient`.

- [ ] **Step 1: Add the `engine` setting (failing test)**

In `src/hooks/use-settings.test.ts`, add:

```ts
it("defaults editor.engine to worker and accepts lsp", () => {
  expect(mergeSettings({}).editor.engine).toBe("worker");
  expect(mergeSettings({ editor: { engine: "lsp" } }).editor.engine).toBe("lsp");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/hooks/use-settings.test.ts`
Expected: FAIL (`engine` undefined).

- [ ] **Step 3: Add `engine` to settings**

In `src/hooks/use-settings.tsx`: in the `editor` type (near line 21–29) add:

```ts
    engine: "worker" | "lsp";
```

In `DEFAULT_SETTINGS` (line 63) add `engine: "worker"` to the `editor` object. In `mergeSettings` (line ~161) add:

```ts
      engine: partial.editor?.engine === "lsp" ? "lsp" : current.editor.engine,
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/hooks/use-settings.test.ts`
Expected: PASS.

- [ ] **Step 5: Make the worker satisfy the interface + add selector**

In `src/lib/ts-worker/client.ts`, add `notifyDocOpened`/`notifyDocClosed` to the `Client` class (worker maps open→existing change path, close→no-op):

```ts
  notifyDocOpened(path: string, content: string): void {
    // Worker loads files via docChanged; opening is the same as a first change.
    this.notifyDocChanged(path, content);
  }
  notifyDocClosed(_path: string): void {
    // Worker keeps files in its VFS; nothing to release.
  }
```

Then append to `src/lib/intelligence.ts`:

```ts
import { LspClient } from "./lsp/client";
import { tsClient } from "./ts-worker/client";

let lspSingleton: LspClient | null = null;

/** Returns the active intelligence engine for the current setting. */
export function intelligenceClient(engine: "worker" | "lsp"): IntelligenceClient {
  if (engine === "lsp") {
    if (!lspSingleton) lspSingleton = new LspClient();
    return lspSingleton;
  }
  return tsClient();
}
```

- [ ] **Step 6: Verify typecheck + tests**

Run: `npm run typecheck 2>&1 | grep -E "intelligence|ts-worker/client|use-settings" || echo "no new errors"`
Expected: `no new errors` (pre-existing cm.ts errors are unrelated).
Run: `npx vitest run src/hooks/use-settings.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/intelligence.ts src/lib/ts-worker/client.ts src/hooks/use-settings.tsx src/hooks/use-settings.test.ts
git commit -m "feat(lsp): editor.engine setting + intelligenceClient selector"
```

---

## Task 8: Wire CodeMirror to the selector + document lifecycle

**Files:**
- Modify: `src/lib/ts-worker/cm.ts`
- Modify: `src/components/editor/code-editor.tsx`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `intelligenceClient(engine)` (Task 7).
- Produces: editor uses the selected engine; sends didOpen on view, didChange on edit, didClose on tab close; calls `openProject` on the selected engine.

- [ ] **Step 1: Route cm.ts extensions through the selector**

In `src/lib/ts-worker/cm.ts`, replace each `tsClient()` call inside the extension bodies (completion source, linter, hover) with a passed-in getter. Change each exported factory to accept the client, e.g. `tsLinterExtension(getPath, getClient)` where `getClient(): IntelligenceClient`. Concretely, add a parameter and use it:

```ts
// example for the linter — apply the same getClient parameter to
// tsCompletionSource, tsLinterExtension, tsHoverExtension:
export function tsLinterExtension(
  getPath: () => string,
  getClient: () => import("@/lib/intelligence").IntelligenceClient,
): Extension {
  return linter(async (view) => {
    const client = getClient();
    const path = getPath();
    if (!isTsWorkerPath(path) || !client.ready()) return [];
    const docLen = view.state.doc.length;
    const diags = await client.getDiagnostics(path);
    return diags
      .filter((d) => d.from <= docLen)
      .map((d): Diagnostic => ({ from: d.from, to: Math.min(d.to, docLen), severity: d.severity, message: d.message }));
  }, { delay: 250 });
}
```

Do the same substitution (`tsClient()` → `getClient()`) in `tsCompletionSource` and `tsHoverExtension`, and in `tsGoToDefHoverAffordance` leave it as-is (it only reads settings, no client). Update `onTypesUpdated` usage to go through the client.

> Ripple: adding the `getClient` parameter changes these exported signatures, so every caller must be updated — `code-editor.tsx` (Step 2 below) and any test that constructs them directly (`src/components/editor/lint-refresh.test.ts`). Run `npm test` after Step 5 and fix callers the compiler/test flags; pass a `() => tsClient()` getter in tests to preserve existing behavior.

- [ ] **Step 2: Thread the client through code-editor.tsx**

In `src/components/editor/code-editor.tsx`:
- Add `engine` from settings: `const { ..., engine } = settings.editor;` and a ref `engineRef`.
- Add a stable getter: `const getClient = useRef(() => intelligenceClient(engineRef.current));`
- Pass `getClient.current` to the cm factory calls in `buildLintExtensions` / `tsCompletionSource`.
- In the `updateListener` docChanged branch, replace `tsClient().notifyDocChanged(...)` with `getClient.current().notifyDocChanged(pathRef.current, docString)`.
- On mount and on path-swap (the effect at line ~372), call `getClient.current().notifyDocOpened(path, content)`.
- In the mousedown go-to-def handler, replace `tsClient()` with `getClient.current()` and its `.ready()`/`.getDefinition(...)`.

```ts
// mount / tab-swap open:
useEffect(() => {
  const c = getClient.current();
  if (c.ready()) c.notifyDocOpened(pathRef.current, content);
}, [path]);
```

- [ ] **Step 3: Open the project on the selected engine**

In `src/App.tsx` (the effect near line 95), replace `tsClient().openProject(rootPath)` with:

```ts
void intelligenceClient(settings.editor.engine).openProject(rootPath).catch(() => {});
```

Add `settings.editor.engine` to that effect's dependency array.

- [ ] **Step 4: Manual smoke (dev build) + typecheck**

Run: `npm run typecheck 2>&1 | grep -E "cm.ts|code-editor|App.tsx" | grep -v "9,8\|227,30" || echo "no new errors"`
Expected: `no new errors`.
Run (manual): `npm run tauri:dev`, open a TS file with `editor.engine` still `"worker"` — everything works exactly as before (selector returns the worker).

- [ ] **Step 5: Commit**

```bash
git add src/lib/ts-worker/cm.ts src/components/editor/code-editor.tsx src/App.tsx
git commit -m "feat(lsp): route editor intelligence through engine selector + doc lifecycle"
```

---

## Task 9: Integration parity test against the real project

**Files:**
- Create: `src/lib/lsp/lsp.integration.test.ts`

**Interfaces:**
- Consumes: `LspClient` (Task 6) with a Node-child transport that spawns the bundled server directly (no Tauri), against the real `lugway` project.

- [ ] **Step 1: Write the parity test**

Create `src/lib/lsp/lsp.integration.test.ts`:

```ts
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { LspClient } from "./client";
import { parseFramesJS } from "./protocol";
import type { Transport } from "./transport";

const ROOT = "/Users/cirx/Desktop/projects/personal/lugway";
const NODE = `${process.cwd()}/resources/lsp/node`;
const CLI = `${process.cwd()}/resources/lsp/server/node_modules/typescript-language-server/lib/cli.mjs`;
const ok = existsSync(ROOT) && existsSync(CLI);

// Node-child transport (bypasses Tauri) so the real server can be driven here.
function nodeTransport(root: string): { id: number; transport: Transport } {
  const child = spawn(NODE, [CLI, "--stdio"], { cwd: root });
  const msgCbs = new Set<(m: string) => void>();
  let carry = Buffer.alloc(0);
  child.stdout.on("data", (chunk: Buffer) => {
    carry = Buffer.concat([carry, chunk]);
    const { messages, rest } = parseFramesJS(carry);
    carry = rest;
    messages.forEach((m) => msgCbs.forEach((cb) => cb(m)));
  });
  const transport: Transport = {
    send: async (m) => {
      child.stdin.write(`Content-Length: ${Buffer.byteLength(m)}\r\n\r\n${m}`);
    },
    onMessage(cb) {
      msgCbs.add(cb);
      return () => msgCbs.delete(cb);
    },
    onExit() {
      return () => {};
    },
    dispose() {
      child.kill();
    },
  };
  return { id: 1, transport };
}

describe.skipIf(!ok)("LSP parity on real lugway monorepo", () => {
  it("resolves @/ alias and go-to-definition in mobile", async () => {
    const c = new LspClient(async () => nodeTransport(ROOT));
    await c.openProject(ROOT);
    const file = `${ROOT}/mobile/app/wallet/top-up.tsx`;
    const fs = await import("node:fs");
    const src = fs.readFileSync(file, "utf8");
    c.notifyDocOpened(file, src);
    // give tsserver time to build the project + publish diagnostics
    await new Promise((r) => setTimeout(r, 8000));
    const diags = await c.getDiagnostics(file);
    const aliasErrs = diags.filter((d) => /Cannot find module '@\//.test(d.message));
    expect(aliasErrs).toEqual([]);
    const off = src.indexOf("useWallet", src.indexOf('from "@/contexts/wallet"') - 40);
    const def = await c.getDefinition(file, off);
    expect(def?.path).toContain("mobile/contexts/wallet");
    c.closeProject();
  }, 30_000);
});
```

- [ ] **Step 2: Add the JS frame parser used by the test transport**

In `src/lib/lsp/protocol.ts`, append (mirrors the Rust parser for the Node-child test transport):

```ts
/** Node-side Content-Length frame parser (used by the integration test's
 *  child-process transport; the Tauri path frames in Rust). */
export function parseFramesJS(buf: Buffer): { messages: string[]; rest: Buffer } {
  const messages: string[] = [];
  let b = buf;
  for (;;) {
    const sep = b.indexOf("\r\n\r\n");
    if (sep === -1) break;
    const header = b.subarray(0, sep).toString("utf8");
    const match = /content-length:\s*(\d+)/i.exec(header);
    if (!match) {
      b = b.subarray(sep + 4);
      continue;
    }
    const len = Number(match[1]);
    const start = sep + 4;
    if (b.length < start + len) break;
    messages.push(b.subarray(start, start + len).toString("utf8"));
    b = b.subarray(start + len);
  }
  return { messages, rest: b };
}
```

- [ ] **Step 3: Run the parity test**

Run: `npx vitest run src/lib/lsp/lsp.integration.test.ts`
Expected: PASS (or SKIP if `lugway`/`resources/lsp` are absent on the machine). The assertions are the same ones that currently FAIL on the worker: `@/contexts/wallet` resolves, definition lands in `mobile/contexts/wallet`.

- [ ] **Step 4: Full suite + commit**

Run: `npm test`
Expected: all pass (existing 84 + new LSP tests).

```bash
git add src/lib/lsp/lsp.integration.test.ts src/lib/lsp/protocol.ts
git commit -m "test(lsp): parity integration test against real monorepo"
```

---

## Post-plan (out of scope here, tracked for follow-up)

- Prove parity/stability with `editor.engine: "lsp"`, then flip the default.
- Follow-up PR: delete `src/lib/ts-worker/*` and the `engine` flag.
- Follow-up: `completionItem/resolve` for auto-import `additionalTextEdits`.
- Follow-up: register `pyright` for Python (reuses bundled Node + client + transport).
- Confirm macOS codesigning/notarization of the bundled `node` binary.

## Self-review notes

- **Spec coverage:** bundling (T1), Rust bridge+framing (T2–T3), protocol helpers (T4), transport (T5), client+features (T6), selector+setting (T7), CodeMirror wiring+lifecycle (T8), parity testing (T9). Error handling (crash → `lsp-exit` + `isReady=false`) is present; full auto-restart/backoff is deferred to a follow-up and noted.
- **Interface consistency:** `IntelligenceClient` defined in T6 and implemented by both engines (T6 LSP, T7 worker additions); `Transport` defined T5, consumed T6/T9; `spawnServer`/`parse_frames`/`parseFramesJS` names consistent across tasks.
