import type { CompletionItemData, DiagnosticData } from "./protocol";

const DEFAULTS = {
  allowJs: true,
  skipLibCheck: true,
  esModuleInterop: true,
  allowSyntheticDefaultImports: true,
  libReplacement: false,
};

/**
 * Join a tsconfig-relative path (baseUrl) onto the project root, producing an
 * absolute path. Leaves already-absolute paths alone. Used so `baseUrl` and
 * `paths` resolve against the real project directory in the worker.
 */
function absJoin(root: string, rel: string): string {
  if (rel.startsWith("/")) return rel.replace(/\/+$/, "");
  const cleaned = rel.replace(/^\.\//, "").replace(/\/+$/, "");
  return cleaned === "" || cleaned === "." ? root : `${root}/${cleaned}`;
}

export function mapCompilerOptions(tsconfigText: string | null, ts: any, root?: string): any {
  const base: any = {
    ...DEFAULTS,
    jsx: ts.JsxEmit.ReactJSX,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  };
  if (!tsconfigText) return base;
  try {
    // Tolerates comments/trailing commas when ts.parseConfigFileTextToJson is
    // available (worker passes real ts); the test's fakeTs lacks it → JSON.parse.
    const json = ts.parseConfigFileTextToJson
      ? ts.parseConfigFileTextToJson("tsconfig.json", tsconfigText).config
      : JSON.parse(tsconfigText);
    const co = json?.compilerOptions ?? {};
    for (const key of [
      "strict",
      "checkJs",
      "noUnusedLocals",
      "noUnusedParameters",
      "exactOptionalPropertyTypes",
      "noImplicitAny",
    ]) {
      if (co[key] !== undefined) base[key] = co[key];
    }
    // Forward path aliases so imports like `@/lib/posts` (Next.js, Expo/RN) and
    // monorepo aliases resolve. TS resolves `paths` against
    //   options.baseUrl ?? options.pathsBasePath ?? host.getCurrentDirectory()
    // and the worker's host returns the project root from getCurrentDirectory(),
    // so forwarding `paths` alone is enough for the common baseUrl-less case
    // (`{"@/*": ["./*"]}`). When the tsconfig DOES set baseUrl we absolutize it
    // against root: a relative baseUrl like "./" would otherwise misplace both
    // baseUrl-style bare resolution and any path patterns anchored to it.
    if (co.paths && typeof co.paths === "object") base.paths = co.paths;
    if (typeof co.baseUrl === "string") {
      base.baseUrl = root ? absJoin(root, co.baseUrl) : co.baseUrl;
    }
    return base;
  } catch {
    return base;
  }
}

/**
 * Merge the `paths` maps of every discovered tsconfig/jsconfig into ONE alias
 * table with ABSOLUTE substitutions. A single LanguageService has a single set
 * of compiler options, but a monorepo has one tsconfig per package, each with
 * `paths` (e.g. `@/*`) anchored to a DIFFERENT directory. We rebase each
 * substitution against its own config's base (baseUrl if set, else the config's
 * dir) so the mapping is self-locating, then union same-pattern substitutions
 * into a candidate list. TS's path resolver combines an absolute substitution
 * over the base (which no-ops the base) and tries each candidate until one
 * exists on disk — so `@/contexts/x` from `mobile/` finds `mobile/contexts/x`
 * while `@/x` from `apps/api/` finds `apps/api/x`, with no cross-talk.
 */
export function mergeConfigPaths(
  configs: { dir: string; text: string }[],
  ts: any,
): Record<string, string[]> | undefined {
  const merged: Record<string, string[]> = {};
  for (const { dir, text } of configs) {
    let json: any;
    try {
      json = ts.parseConfigFileTextToJson
        ? ts.parseConfigFileTextToJson("tsconfig.json", text).config
        : JSON.parse(text);
    } catch {
      continue;
    }
    const co = json?.compilerOptions ?? {};
    if (!co.paths || typeof co.paths !== "object") continue;
    const base = typeof co.baseUrl === "string" ? absJoin(dir, co.baseUrl) : dir;
    for (const [pattern, subs] of Object.entries(co.paths)) {
      if (!Array.isArray(subs)) continue;
      const list = (merged[pattern] ??= []);
      for (const sub of subs) {
        if (typeof sub !== "string") continue;
        const abs = absJoin(base, sub); // preserves the trailing `/*` wildcard
        if (!list.includes(abs)) list.push(abs);
      }
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function scriptKindForPath(path: string): "ts" | "tsx" | "js" | "jsx" | "other" {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "ts" || ext === "mts" || ext === "cts") return "ts";
  if (ext === "tsx") return "tsx";
  if (ext === "js" || ext === "mjs" || ext === "cjs") return "js";
  if (ext === "jsx") return "jsx";
  return "other";
}

export function packageFileCandidates(moduleName: string, root: string): string[] {
  if (moduleName.startsWith(".") || moduleName.startsWith("/")) return [];
  // bare specifier → package name (strip deep subpath beyond the package)
  const parts = moduleName.split("/");
  const pkg = moduleName.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  const typesTwin = pkg.startsWith("@")
    ? `@types/${pkg.slice(1).replace("/", "__")}`
    : `@types/${pkg}`;
  const out: string[] = [];
  for (const p of [pkg, typesTwin]) {
    out.push(`${root}/node_modules/${p}/package.json`);
    out.push(`${root}/node_modules/${p}/index.d.ts`);
  }
  // deep subpath probes (e.g. react/jsx-runtime)
  if (parts.length > (moduleName.startsWith("@") ? 2 : 1)) {
    out.push(`${root}/node_modules/${moduleName}.d.ts`);
    out.push(`${root}/node_modules/${moduleName}/index.d.ts`);
    out.push(`${root}/node_modules/${moduleName}/package.json`);
  }
  return out;
}

export function tsDiagnosticsToData(diags: any[], fileText: string, ts: any): DiagnosticData[] {
  const out: DiagnosticData[] = [];
  for (const d of diags) {
    if (d.start === undefined) continue;
    const from = d.start;
    const to = Math.min(d.start + Math.max(d.length ?? 1, 1), fileText.length);
    const severity =
      d.category === ts.DiagnosticCategory.Error
        ? "error"
        : d.category === ts.DiagnosticCategory.Warning
          ? "warning"
          : "info";
    out.push({ from, to, severity, message: ts.flattenDiagnosticMessageText(d.messageText, "\n") });
    if (out.length >= 200) break;
  }
  return out;
}

export function tsCompletionsToData(info: any): CompletionItemData[] {
  if (!info?.entries) return [];
  const items: CompletionItemData[] = [];
  for (const e of info.entries) {
    items.push({
      label: e.name,
      kind: e.kind,
      detail: e.source ? shortenSource(e.source) : undefined,
      sortText: e.sortText ?? "",
      insertText: e.insertText,
      source: e.source,
      data: e.data,
    });
    if (items.length >= 300) break;
  }
  return items;
}

function shortenSource(source: string): string {
  const i = source.lastIndexOf("node_modules/");
  return i === -1 ? source : source.slice(i + "node_modules/".length);
}
