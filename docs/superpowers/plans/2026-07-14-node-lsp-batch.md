# Node-based LSP Batch (bundled) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add full LSP intelligence for 9 more languages (bash, YAML, JSON, HTML, CSS, Dockerfile, Svelte, GraphQL, Vue) by bundling their Node-based language servers under the already-shipped Node runtime, marked "Built-in".

**Architecture:** These servers all run under `resources/lsp/node` from `resources/lsp/server/node_modules/…`, exactly like the existing bundled typescript/pyright servers. They are fetched at BUILD time by `scripts/fetch-lsp.mjs` (developer's npm), ship as Tauri resources, and are therefore always available (no download-on-first-use). Routing reuses `SERVER_FOR_LANG` (manager.ts) and `resolve_command` (lsp.rs). Vue additionally needs `initializationOptions.typescript.tsdk`, delivered via a new general `lsp_init_options(serverId)` Rust command the client merges into its `initialize`.

**Tech Stack:** Tauri v2 (Rust), React/TypeScript, existing LspClient/manager, npm-distributed language servers.

## Global Constraints

- Servers are **bundled** (kind `"bundled"`, state `"builtin"` in `lsp_server_status`) — NO download-on-first-use, NO "Install" button. They appear with a "Built-in" badge.
- All resolve to the bundled node: `resource(app, "lsp/node")` + an entrypoint under `resource(app, "lsp/server/node_modules/<pkg>/<entry>")`.
- Pinned versions (exact): bash-language-server@5.6.0, yaml-language-server@1.24.0, vscode-langservers-extracted@4.10.0, dockerfile-language-server-nodejs@0.15.0, svelte-language-server@0.18.3, graphql-language-service-cli@3.5.0, @vue/language-server@3.3.7.
- Exact server entrypoints + invocation (verified via `npm view <pkg> bin`):
  - bash → `bash-language-server/out/cli.js` + arg `start` (NOT `--stdio`)
  - yaml → `yaml-language-server/bin/yaml-language-server` + `--stdio`
  - json → `vscode-langservers-extracted/bin/vscode-json-language-server` + `--stdio`
  - html → `vscode-langservers-extracted/bin/vscode-html-language-server` + `--stdio`
  - css → `vscode-langservers-extracted/bin/vscode-css-language-server` + `--stdio`
  - dockerfile → `dockerfile-language-server-nodejs/bin/docker-langserver` + `--stdio`
  - svelte → `svelte-language-server/bin/server.js` + `--stdio`
  - graphql → `graphql-language-service-cli/bin/graphql.js` + args `server -m stream` (NOT `--stdio`)
  - vue → `@vue/language-server/bin/vue-language-server.js` + `--stdio` + `initializationOptions.typescript.tsdk`
- serverIds (frontend `SERVER_FOR_LANG` values ↔ Rust `resolve_command` arms ↔ `lsp_server_status` ids) MUST match exactly: `bash, yaml, json, html, css, dockerfile, svelte, graphql, vue`.
- Tailwind is explicitly OUT of scope (needs multi-server-per-document).
- Every entrypoint MUST be invoked via the bundled node (point node at the JS file / bin script; the bin scripts carry `#!/usr/bin/env node` shebangs which node ignores).

---

### Task 1: Bundle the server packages at build time

**Files:**
- Modify: `scripts/fetch-lsp.mjs`

**Interfaces:**
- Produces: `resources/lsp/server/node_modules/<pkg>/…` for all 7 packages, so `resolve_command` (Task 3) can point at real entrypoints.

- [ ] **Step 1: Add the packages to the install list**

In `scripts/fetch-lsp.mjs`, add version constants and extend the single `npm install` in `installServer()` to include all new packages. Replace the existing `installServer` install line so the `npm install --omit=dev` command also installs:
`bash-language-server@5.6.0 yaml-language-server@1.24.0 vscode-langservers-extracted@4.10.0 dockerfile-language-server-nodejs@0.15.0 svelte-language-server@0.18.3 graphql-language-service-cli@3.5.0 @vue/language-server@3.3.7`
(keep the existing typescript-language-server/typescript/pyright entries).

- [ ] **Step 2: Update the idempotency guard**

`installServer()` currently early-returns when `typescript-language-server/lib/cli.mjs` AND `pyright/langserver.index.js` exist. Extend the guard so a partial install (new packages missing) re-runs. Add existence checks for at least: `bash-language-server/out/cli.js`, `vscode-langservers-extracted/bin/vscode-json-language-server`, `@vue/language-server/bin/vue-language-server.js`, `graphql-language-service-cli/bin/graphql.js`. Only early-return when ALL are present.

- [ ] **Step 3: Run it and verify entrypoints exist**

Run: `node scripts/fetch-lsp.mjs`
Then verify each entrypoint exists on disk:
`ls resources/lsp/server/node_modules/bash-language-server/out/cli.js resources/lsp/server/node_modules/yaml-language-server/bin/yaml-language-server resources/lsp/server/node_modules/vscode-langservers-extracted/bin/vscode-json-language-server resources/lsp/server/node_modules/vscode-langservers-extracted/bin/vscode-html-language-server resources/lsp/server/node_modules/vscode-langservers-extracted/bin/vscode-css-language-server resources/lsp/server/node_modules/dockerfile-language-server-nodejs/bin/docker-langserver resources/lsp/server/node_modules/svelte-language-server/bin/server.js resources/lsp/server/node_modules/graphql-language-service-cli/bin/graphql.js resources/lsp/server/node_modules/@vue/language-server/bin/vue-language-server.js resources/lsp/server/node_modules/typescript/lib`
Expected: every path exists. If a bin path differs from the plan, RECORD the actual path — Task 3 must use the real path.

- [ ] **Step 4: Commit**

```bash
git add scripts/fetch-lsp.mjs
git commit -m "build(lsp): bundle 7 node language servers (bash/yaml/json-html-css/docker/svelte/graphql/vue)"
```

---

### Task 2: Language keys, extensions, and routing

**Files:**
- Modify: `src/lib/language.ts`
- Modify: `src/lib/lsp/manager.ts`
- Test: `src/lib/lsp/manager.test.ts`

**Interfaces:**
- Consumes: `serverIdForPath` / `SERVER_FOR_LANG` (manager.ts), `LanguageKey` + extension maps (language.ts).
- Produces: `serverIdForPath("x.vue") === "vue"`, etc., for all 9 languages.

- [ ] **Step 1: Add new LanguageKeys + extensions (language.ts)**

`html`, `css`, `json`, `yaml`, `shell`, `dockerfile` keys ALREADY exist. Add three NEW keys to the `LanguageKey` union: `"vue"`, `"svelte"`, `"graphql"`. Add extension→key entries: `vue: "vue"`, `svelte: "svelte"`, `graphql: "graphql"`, `gql: "graphql"`. Add display-name entries: `vue: "Vue"`, `svelte: "Svelte"`, `graphql: "GraphQL"`.

- [ ] **Step 2: Route languages → serverIds (manager.ts)**

Extend `SERVER_FOR_LANG` with: `shell: "bash"`, `yaml: "yaml"`, `json: "json"`, `html: "html"`, `css: "css"`, `dockerfile: "dockerfile"`, `svelte: "svelte"`, `graphql: "graphql"`, `vue: "vue"`. (Keep existing typescript/python/rust/go/c/cpp entries.)

- [ ] **Step 3: Write/extend the routing test (manager.test.ts)**

Add assertions to `manager.test.ts` (follow the existing test's style):
```ts
expect(serverIdForPath("a.vue")).toBe("vue");
expect(serverIdForPath("a.svelte")).toBe("svelte");
expect(serverIdForPath("schema.graphql")).toBe("graphql");
expect(serverIdForPath("q.gql")).toBe("graphql");
expect(serverIdForPath("deploy.yml")).toBe("yaml");
expect(serverIdForPath("config.json")).toBe("json");
expect(serverIdForPath("index.html")).toBe("html");
expect(serverIdForPath("styles.css")).toBe("css");
expect(serverIdForPath("Dockerfile")).toBe("dockerfile");
expect(serverIdForPath("run.sh")).toBe("bash");
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/lib/lsp/manager.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/language.ts src/lib/lsp/manager.ts src/lib/lsp/manager.test.ts
git commit -m "feat(lsp): route 9 node-server languages (+vue/svelte/graphql keys)"
```

---

### Task 3: Rust registry — resolve_command, ensure, status

**Files:**
- Modify: `src-tauri/src/lsp.rs`

**Interfaces:**
- Consumes: `resource(app, rel)`, existing `resolve_command`, `ensure_server_blocking`, `lsp_server_status`.
- Produces: spawnable + status-visible bundled servers for all 9 new ids.

- [ ] **Step 1: Add resolve_command arms**

In `resolve_command`, before the `_ => Err(...)` catch-all, add one arm per server. Each returns `(node, vec![entry, args…])` where `node = resource(app, "lsp/node")?` (already bound at the top of the fn) and `entry = resource(app, "lsp/server/node_modules/<pkg>/<file>")?.to_string_lossy().into()`:

```rust
"bash" => {
    let cli = resource(app, "lsp/server/node_modules/bash-language-server/out/cli.js")?;
    Ok((node, vec![cli.to_string_lossy().into(), "start".into()]))
}
"yaml" => {
    let cli = resource(app, "lsp/server/node_modules/yaml-language-server/bin/yaml-language-server")?;
    Ok((node, vec![cli.to_string_lossy().into(), "--stdio".into()]))
}
"json" => {
    let cli = resource(app, "lsp/server/node_modules/vscode-langservers-extracted/bin/vscode-json-language-server")?;
    Ok((node, vec![cli.to_string_lossy().into(), "--stdio".into()]))
}
"html" => {
    let cli = resource(app, "lsp/server/node_modules/vscode-langservers-extracted/bin/vscode-html-language-server")?;
    Ok((node, vec![cli.to_string_lossy().into(), "--stdio".into()]))
}
"css" => {
    let cli = resource(app, "lsp/server/node_modules/vscode-langservers-extracted/bin/vscode-css-language-server")?;
    Ok((node, vec![cli.to_string_lossy().into(), "--stdio".into()]))
}
"dockerfile" => {
    let cli = resource(app, "lsp/server/node_modules/dockerfile-language-server-nodejs/bin/docker-langserver")?;
    Ok((node, vec![cli.to_string_lossy().into(), "--stdio".into()]))
}
"svelte" => {
    let cli = resource(app, "lsp/server/node_modules/svelte-language-server/bin/server.js")?;
    Ok((node, vec![cli.to_string_lossy().into(), "--stdio".into()]))
}
"graphql" => {
    let cli = resource(app, "lsp/server/node_modules/graphql-language-service-cli/bin/graphql.js")?;
    Ok((node, vec![cli.to_string_lossy().into(), "server".into(), "-m".into(), "stream".into()]))
}
"vue" => {
    let cli = resource(app, "lsp/server/node_modules/@vue/language-server/bin/vue-language-server.js")?;
    Ok((node, vec![cli.to_string_lossy().into(), "--stdio".into()]))
}
```
Use the ACTUAL entrypoints recorded in Task 1 if any differed.

- [ ] **Step 2: Mark them bundled in ensure_server_blocking**

In `ensure_server_blocking`, extend the no-op bundled arm to include the new ids:
```rust
"typescript" | "python" | "bash" | "yaml" | "json" | "html" | "css" | "dockerfile" | "svelte" | "graphql" | "vue" => Ok(()),
```

- [ ] **Step 3: Add lsp_server_status entries**

In `lsp_server_status`, add `entry(…)` rows (kind `"bundled"` → state `"builtin"`) after the existing python row:
```rust
entry("bash", "Bash", &["sh", "bash"], "bundled"),
entry("yaml", "YAML", &["yml", "yaml"], "bundled"),
entry("json", "JSON", &["json"], "bundled"),
entry("html", "HTML", &["html"], "bundled"),
entry("css", "CSS", &["css"], "bundled"),
entry("dockerfile", "Dockerfile", &["dockerfile"], "bundled"),
entry("svelte", "Svelte", &["svelte"], "bundled"),
entry("graphql", "GraphQL", &["graphql", "gql"], "bundled"),
entry("vue", "Vue", &["vue"], "bundled"),
```

- [ ] **Step 4: Build + test**

Run: `cd src-tauri && cargo build` → clean, 0 warnings. `cargo test --lib` → all pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/lsp.rs
git commit -m "feat(lsp): registry + status for 9 bundled node servers"
```

---

### Task 4: Vue tsdk via general per-server initializationOptions

**Files:**
- Modify: `src-tauri/src/lsp.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/lib/lsp/client.ts`
- Modify: `src/lib/lsp/transport.ts` (only if a helper is needed)
- Test: `src/lib/lsp/client.test.ts`

**Interfaces:**
- Consumes: `resolve_command`/`resource`; the client's `initialize` request in `openProject`.
- Produces: Vue's server receives `initializationOptions.typescript.tsdk`; all other servers unaffected.

- [ ] **Step 1: Rust command returning per-server init options**

Add to `lsp.rs`:
```rust
/// Per-server `initializationOptions` with resolved resource paths. Returns
/// `null` for servers that need none. Vue (Volar) requires the TypeScript SDK
/// lib dir; we ship `typescript` as a bundled resource.
#[tauri::command]
pub fn lsp_init_options(server_id: String, app: AppHandle) -> Result<Option<serde_json::Value>, String> {
    match server_id.as_str() {
        "vue" => {
            let tsdk = resource(&app, "lsp/server/node_modules/typescript/lib")?;
            Ok(Some(serde_json::json!({
                "typescript": { "tsdk": tsdk.to_string_lossy() }
            })))
        }
        _ => Ok(None),
    }
}
```
Register `lsp::lsp_init_options` in `lib.rs`'s `generate_handler!`.

- [ ] **Step 2: Client merges init options into initialize**

In `client.ts` `openProject`, BEFORE sending `initialize`, fetch the options and include them as `initializationOptions`:
```ts
let initOptions: unknown = undefined;
try {
  initOptions = await invoke("lsp_init_options", { serverId: this.serverId });
} catch { /* ignore — proceed without */ }
```
Add `initializationOptions: initOptions ?? undefined` to the existing `initialize` params object. `this.serverId` is already a constructor field. If `client.ts` doesn't already import `invoke`, import it from `@tauri-apps/api/core`. Keep the fake-transport tests working (they don't call the real `invoke`) — so guard the invoke behind a check or ensure the test transport path doesn't require Tauri. If `invoke` is unavailable under vitest, wrap in try/catch (already shown) so it degrades to `undefined`.

- [ ] **Step 3: Test — initialize carries initializationOptions when provided**

In `client.test.ts`, the existing fake `spawn` returns a transport; the client will call `invoke("lsp_init_options")` which is not mocked. Add a vitest mock so `invoke` resolves to `null` by default (no options) and assert the existing "initializes and reports ready" test still passes. Add ONE new test: mock `invoke` to resolve `{ typescript: { tsdk: "/x/lib" } }` and assert the `initialize` message's `params.initializationOptions` equals that object. Use `vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }))` and set its resolved value per test.

- [ ] **Step 4: Run tests + build**

Run: `npx vitest run src/lib/lsp/client.test.ts` → PASS. `cd src-tauri && cargo build` → clean.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/lsp.rs src-tauri/src/lib.rs src/lib/lsp/client.ts src/lib/lsp/client.test.ts
git commit -m "feat(lsp): per-server initializationOptions; wire Vue tsdk"
```

---

### Task 5: Integration probe — each server spawns and initializes

**Files:**
- Create: `src/lib/lsp/node-batch.integration.test.ts`

**Interfaces:**
- Consumes: `LspClient(serverId)` spawned via a Node child-process transport (like `multilang.integration.test.ts`), one tiny fixture per language.

- [ ] **Step 1: Write a spawn+diagnostics/initialize probe per language**

Create `src/lib/lsp/node-batch.integration.test.ts` mirroring `multilang.integration.test.ts`'s child-process transport + `framesJS` helpers (copy them in — test-local). Build a `spec` table for the 9 servers, each row `{ serverId, cmd: NODE, args: [entry, …], file, source }`. `NODE = ${process.cwd()}/resources/lsp/node`; entries are the same paths as Task 3. For each, `describe.skipIf(!existsSync(entry))`. The assertion is lenient: open a tiny valid file for the language and assert the server **initializes and responds** (e.g., `c.ready() === true` after `openProject`, and `getHover`/`getDiagnostics` returns without throwing within a timeout). Do NOT assert specific diagnostic text (these servers vary); the goal is "spawns + initializes + answers", not content. For `vue`, pass the tsdk `initializationOptions` inline in the fake spawn (point tsdk at `resources/lsp/server/node_modules/typescript/lib`).

- [ ] **Step 2: Run**

Run: `npx vitest run src/lib/lsp/node-batch.integration.test.ts`
Expected: rows whose entrypoint exists RUN and pass (server initializes); missing ones skip. Report which ran.

- [ ] **Step 3: Commit**

```bash
git add src/lib/lsp/node-batch.integration.test.ts
git commit -m "test(lsp): spawn/initialize probe for the 9 bundled node servers"
```

---

## Self-Review

- **Spec coverage:** 9 languages bundled (T1) → keys/routing (T2) → Rust registry+status (T3) → Vue tsdk init options (T4) → spawn probe (T5). Tailwind explicitly deferred.
- **Type/id consistency:** serverIds `bash/yaml/json/html/css/dockerfile/svelte/graphql/vue` are identical across `SERVER_FOR_LANG` (T2), `resolve_command`/`ensure_server_blocking`/`lsp_server_status` (T3), `lsp_init_options` (T4), and the probe (T5). Entrypoint paths in T3/T5 match what T1 installs (verify in T1 Step 3; use actual paths if any differ).
- **Quirks captured:** bash `start`, graphql `server -m stream`, vue `initializationOptions.typescript.tsdk` — all in Global Constraints + the relevant task.
- **Placeholder scan:** entrypoints, versions, args, serverIds are all concrete.
