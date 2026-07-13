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
const host: ts.LanguageServiceHost = {
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
};

// ---- miss flushing ----------------------------------------------------------
function flushWanted() {
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
      service = ts.createLanguageService(host);
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
    case "filesLoaded": {
      let changed = false;
      for (const f of req.files as FileEntry[]) {
        pending.delete(f.path);
        if (f.content === null) missing.add(f.path);
        else {
          setFile(f.path, f.content);
          changed = true;
        }
      }
      if (changed) {
        // Retry resolutions TS has already cached as failed. When a bare
        // specifier resolves through a package's package.json "exports"/"types"
        // map, TS must read that package.json AT resolution time. On the first
        // lint the manifest isn't in the VFS yet (readFile returns undefined and
        // is only recorded as a want), so TS can't parse the exports map, falls
        // back to legacy resolution — which fails for exports-only packages like
        // react-router-dom — and CACHES that failure. When the manifest later
        // arrives here, the LanguageService reuses its cached program and module
        // resolutions (the package.json is not a script file, so no script
        // version changes to force re-resolution) and never retries, leaving a
        // permanent "Cannot find module" even though the package is present.
        // getProjectVersion bumps alone do NOT invalidate that failed-lookup
        // cache. cleanupSemanticCache() drops the cached programs/resolutions so
        // the next lint re-resolves fresh against the now-larger VFS; clearing
        // `missing` lets any path previously recorded absent (including a real
        // file that briefly came back content:null — over the 2 MB read cap,
        // binary, or a transient read rejection) be re-probed. This
        // self-terminates: `files` only grows, so eventually a round loads
        // nothing new (`changed` stays false), `missing` sticks, and the loop
        // converges.
        missing.clear();
        projectVersion++;
        service?.cleanupSemanticCache();
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
