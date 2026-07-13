/// <reference lib="webworker" />
import * as ts from "typescript";
import { createRpc, type FileEntry, type WorkerRequest } from "./protocol";
import {
  mapCompilerOptions,
  scriptKindForPath,
  tsCompletionsToData,
  tsDiagnosticsToData,
} from "./mapping";

// ---- default libs, bundled lazily into this chunk group -------------------
const libLoaders = import.meta.glob("/node_modules/typescript/lib/lib*.d.ts", {
  query: "?raw",
  import: "default",
}) as Record<string, () => Promise<string>>;
const LIB_DIR = "/__tslibs";

// ---- VFS -------------------------------------------------------------------
const files = new Map<string, { text: string; version: number }>();
const missing = new Set<string>(); // confirmed absent
const pending = new Set<string>(); // asked for, awaiting filesLoaded
let wanted = new Set<string>(); // misses gathered during the current call
let projectVersion = 0;
// When node_modules content arrives after a lint has already cached a FAILED module
// resolution (e.g. a package.json whose exports/types map wasn't in the VFS yet),
// bumping projectVersion alone won't make TS re-resolve — it reuses per-file cached
// resolutions unless the importing file's version changed OR the host reports its
// resolutions invalidated. We flip this flag on content-changing filesLoaded so
// host.hasInvalidatedResolutions() forces a fresh module resolution on the next
// program build, then clear it once that build has run. This is the crash-free
// alternative to cleanupSemanticCache() (which throws inside TS's document registry
// once the VFS churns thousands of node_modules files).
let resolutionsInvalidated = false;
let root = "";
let options: ts.CompilerOptions = {};
let service: ts.LanguageService | null = null;

function setFile(path: string, text: string) {
  const prev = files.get(path);
  files.set(path, { text, version: (prev?.version ?? 0) + 1 });
  projectVersion++;
}

function want(path: string) {
  if (!files.has(path) && !missing.has(path) && !pending.has(path)) wanted.add(path);
}

// ---- host ------------------------------------------------------------------
// `hasInvalidatedResolutions` isn't on the public LanguageServiceHost type (it lives
// on CompilerHost/ProgramHost), but the LanguageService reads it at runtime to decide
// whether to re-run module resolution. Widen the type so we can supply it legally.
const host: ts.LanguageServiceHost & Pick<ts.CompilerHost, "hasInvalidatedResolutions"> = {
  getScriptFileNames: () =>
    [...files.keys()].filter((p) => scriptKindForPath(p) !== "other" || p.endsWith(".d.ts")),
  getScriptVersion: (p) => String(files.get(p)?.version ?? 0),
  getScriptSnapshot: (p) => {
    const f = files.get(p);
    if (f) return ts.ScriptSnapshot.fromString(f.text);
    if (p.includes("/node_modules/")) want(p);
    return undefined;
  },
  readFile: (p) => {
    const f = files.get(p);
    if (f) return f.text;
    if (p.includes("/node_modules/")) want(p);
    return undefined;
  },
  fileExists: (p) => {
    if (files.has(p)) return true;
    if (missing.has(p)) return false;
    if (p.includes("/node_modules/")) want(p);
    return false;
  },
  directoryExists: (d) =>
    d.startsWith(LIB_DIR) ||
    d.startsWith(root) ||
    [...files.keys()].some((p) => p.startsWith(d + "/")),
  getDirectories: () => [],
  getCurrentDirectory: () => root || "/",
  getCompilationSettings: () => options,
  getDefaultLibFileName: (o) => `${LIB_DIR}/${ts.getDefaultLibFileName(o)}`,
  getProjectVersion: () => String(projectVersion),
  // Force TS to re-run module resolution for every file after node_modules content
  // arrives asynchronously. Returning true here (paired with a projectVersion bump)
  // makes the next program build discard the cached "Cannot find module" for
  // exports-map packages and re-resolve against the now-larger VFS.
  hasInvalidatedResolutions: () => resolutionsInvalidated,
};

// ---- miss flushing ----------------------------------------------------------
function flushWanted() {
  // Every service query (diagnostics/completions/hover) calls flushWanted on its way
  // out, AFTER TS has built its program and consumed host.hasInvalidatedResolutions.
  // Clear the flag here so the invalidation applies to exactly one rebuild — leaving
  // it set would keep forcing full re-resolution on every subsequent query forever.
  resolutionsInvalidated = false;
  if (wanted.size === 0) return;
  // Every concrete path TS probed under node_modules (including the package.json /
  // index.d.ts manifests it generates while resolving a bare specifier) has already
  // been captured by want(); the batch is complete. Mark them pending and emit ONE
  // deduped notification, then reset the accumulator for the next request.
  const paths = [...wanted];
  paths.forEach((p) => pending.add(p));
  wanted = new Set();
  rpc.notify({ kind: "needFiles", paths });
}

// ---- offset → line/column mapping (go-to-definition) ------------------------
// Convert a 0-based character offset in `fileName` to a 1-based {line, column} for
// CodeMirror. Uses ts.getLineAndCharacterOfPosition (0-based line/char) on the target
// SourceFile — preferring the program's own (which includes .d.ts under node_modules
// the program loaded), then the VFS text — and shifts both to 1-based. Returns null
// only when neither source is available.
function offsetToLineColumn(
  fileName: string,
  offset: number,
): { line: number; column: number } | null {
  let source: ts.SourceFile | undefined = service?.getProgram()?.getSourceFile(fileName);
  if (!source) {
    const vfs = files.get(fileName);
    if (vfs) {
      source = ts.createSourceFile(fileName, vfs.text, ts.ScriptTarget.ESNext, false);
    }
  }
  if (!source) return null;
  const lc = ts.getLineAndCharacterOfPosition(source, offset);
  return { line: lc.line + 1, column: lc.character + 1 };
}

// ---- request handling --------------------------------------------------------
async function handle(req: WorkerRequest): Promise<unknown> {
  switch (req.kind) {
    case "openProject": {
      root = req.root;
      files.clear();
      missing.clear();
      pending.clear();
      wanted = new Set();
      projectVersion = 0;
      options = mapCompilerOptions(req.tsconfigText, ts);
      // load default libs into the VFS
      await Promise.all(
        Object.entries(libLoaders).map(async ([path, load]) => {
          const name = path.slice(path.lastIndexOf("/") + 1);
          setFile(`${LIB_DIR}/${name}`, await load());
        }),
      );
      for (const f of req.files) setFile(f.path, f.content);
      // Give this LanguageService its OWN document registry rather than the global
      // shared one that createLanguageService(host) defaults to. cleanupSemanticCache()
      // walks the current program's source files and calls releaseDocumentWithKey on
      // each; with the shared registry, entries created under a different bucket/key
      // (or already released) come back undefined and TS crashes reading `.sourceFile`
      // (isDocumentRegistryEntry). This bites once the VFS grows to thousands of churn-
      // ing node_modules files — exactly the real-project case. A private registry keeps
      // every entry consistent with this service, so cleanup is safe.
      service = ts.createLanguageService(host, ts.createDocumentRegistry());
      return true;
    }
    case "docChanged": {
      setFile(req.path, req.content);
      return true;
    }
    case "completions": {
      if (!service) return { items: [], fromOffset: req.offset };
      const info = service.getCompletionsAtPosition(req.path, req.offset, {
        includeCompletionsForModuleExports: true,
        includeCompletionsWithInsertText: true,
        includeCompletionsWithSnippetText: false,
        allowIncompleteCompletions: true,
      });
      flushWanted();
      const fromOffset = info?.optionalReplacementSpan
        ? info.optionalReplacementSpan.start
        : req.offset;
      return { items: tsCompletionsToData(info), fromOffset };
    }
    case "completionDetails": {
      if (!service) return { extraChanges: [] };
      const details = service.getCompletionEntryDetails(
        req.path,
        req.offset,
        req.entryName,
        undefined,
        req.source,
        undefined,
        req.data as ts.CompletionEntryData | undefined,
      );
      flushWanted();
      const extraChanges: { from: number; to: number; insert: string }[] = [];
      for (const action of details?.codeActions ?? []) {
        for (const change of action.changes) {
          if (change.fileName !== req.path) continue; // v1: same-file edits only
          for (const tc of change.textChanges) {
            extraChanges.push({
              from: tc.span.start,
              to: tc.span.start + tc.span.length,
              insert: tc.newText,
            });
          }
        }
      }
      return { extraChanges };
    }
    case "diagnostics": {
      if (!service || !files.has(req.path)) return [];
      const text = files.get(req.path)!.text;
      const all = [
        ...service.getSyntacticDiagnostics(req.path),
        ...service.getSemanticDiagnostics(req.path),
      ];
      flushWanted();
      return tsDiagnosticsToData(all, text, ts);
    }
    case "hover": {
      if (!service) return null;
      const info = service.getQuickInfoAtPosition(req.path, req.offset);
      flushWanted();
      if (!info) return null;
      return {
        text: ts.displayPartsToString(info.displayParts),
        docs: ts.displayPartsToString(info.documentation)?.split("\n")[0] || undefined,
      };
    }
    case "definition": {
      if (!service) return null;
      const defs = service.getDefinitionAtPosition(req.path, req.offset);
      // flushWanted like the other handlers so any node_modules probes triggered
      // while resolving the definition are surfaced to the client for loading.
      flushWanted();
      const def = defs?.[0];
      if (!def) return null;
      // Map the target's 0-based textSpan.start → 1-based {line, column}. Prefer the
      // program's SourceFile (has TS's own line map, incl. .d.ts under node_modules
      // that the program pulled in). Fall back to the VFS text if the target isn't a
      // program source file (rare); return null only when we truly can't position it.
      const pos = offsetToLineColumn(def.fileName, def.textSpan.start);
      if (!pos) return null;
      return { path: def.fileName, line: pos.line, column: pos.column };
    }
    case "filesLoaded": {
      let changed = false;
      // Did THIS batch resolve any path TS was still waiting on (pending)? Even an
      // all-missing batch (every content === null) can flip a diagnostic: once the
      // last probe a resolution was blocked on is confirmed absent, the next program
      // build — forced to re-resolve by hasInvalidatedResolutions — can settle that
      // module (succeed via a different candidate, or emit its final error). We track
      // this so the client re-lints in exactly that case; see the notify below.
      let resolvedPending = false;
      const arrivedManifestDirs: string[] = [];
      for (const f of req.files as FileEntry[]) {
        if (pending.delete(f.path)) resolvedPending = true;
        if (f.content === null) missing.add(f.path);
        else {
          setFile(f.path, f.content);
          changed = true;
          // A newly-arrived package.json can change how paths WITHIN its package
          // resolve (its "exports"/"types" map points at files TS never probed and
          // may have recorded absent). Remember the package dir so we can re-open
          // just those paths for re-probing — see the scoped invalidation below.
          if (f.path.endsWith("/package.json")) {
            arrivedManifestDirs.push(f.path.slice(0, -"/package.json".length));
          }
        }
      }
      if (changed) {
        // Retry resolutions TS has already cached as failed. When a bare specifier
        // resolves through a package's package.json "exports"/"types" map, TS must
        // read that package.json AT resolution time. On the first lint the manifest
        // isn't in the VFS yet (readFile returns undefined, path only recorded as a
        // want), so TS can't parse the exports map, falls back to legacy resolution
        // — which fails for exports-only packages like react-router-dom — and CACHES
        // that failure. When the manifest later arrives, the LanguageService reuses
        // its cached program and module resolutions (the package.json is not a script
        // file, so no script version changes to force re-resolution) and never
        // retries, leaving a permanent "Cannot find module".
        //
        // Two things force the retry, both crash-free:
        //  (1) SCOPED `missing` invalidation: only re-open absent paths UNDER the dir
        //      of an arrived package.json — exactly the paths whose resolution the new
        //      exports/types map can change. Round 1 cleared ALL of `missing`, which on
        //      a real project (huge surface of genuinely-absent probes: wrong-extension
        //      candidates, dist/ and .vite/ ghost dirs, non-existent @types twins) re-
        //      opened everything every round, so `needFiles` never reached 0 and the
        //      loop never converged. Scoping keeps unrelated absences sticky, so `files`
        //      only grows, a round eventually loads nothing new, and needFiles → 0.
        //  (2) resolutionsInvalidated flag: read by host.hasInvalidatedResolutions so
        //      the next program build re-resolves modules instead of reusing the cached
        //      failure. This replaces round 1's cleanupSemanticCache(), which crashes
        //      inside TS's document registry (releaseDocumentWithKey → undefined
        //      `.sourceFile`) once the VFS churns thousands of node_modules files.
        for (const dir of arrivedManifestDirs) {
          const prefix = dir + "/";
          for (const p of [...missing]) if (p.startsWith(prefix)) missing.delete(p);
        }
        projectVersion++;
        resolutionsInvalidated = true;
      }
      // Re-lint signal. Fire `typesUpdated` (the client's forceLinting trigger)
      // whenever open-file diagnostics could now differ:
      //   - `changed`: new content arrived (the always-fired case, as before).
      //   - `resolvedPending && resolutionsInvalidated`: no NEW content this batch, but
      //     we cleared pending probes while a re-resolution is still armed (set by an
      //     earlier content-changing batch and not yet consumed by a diagnostics query).
      //     This is the stale-squiggle case: the final resolution succeeds by RE-
      //     RESOLVING already-loaded files against the now-complete VFS/missing set, so
      //     `changed` is false and — without this — the editor would never re-lint,
      //     leaving stale "Cannot find module" / jsx errors until the user types or
      //     switches files.
      // Loop-safety: we NEVER notify unconditionally. `changed` requires genuinely new
      // content; the second clause requires BOTH a pending path cleared by THIS batch
      // (so `resolvedPending` can't stay true across empty rounds) AND an armed
      // invalidation from a real prior content change. Each round therefore either loads
      // new content, drains pending, or does neither (no notify) — so typesUpdated →
      // diagnostics → needFiles → filesLoaded cannot recur forever; the landing test's
      // round cap proves convergence.
      if (changed || (resolvedPending && resolutionsInvalidated)) {
        rpc.notify({ kind: "typesUpdated" });
      }
      return true;
    }
  }
}

const rpc = createRpc(self as unknown as import("./protocol").RpcPort, (p) =>
  handle(p as WorkerRequest),
);
export {}; // module worker
