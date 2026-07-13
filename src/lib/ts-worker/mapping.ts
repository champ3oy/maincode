import type { CompletionItemData, DiagnosticData } from "./protocol";

const DEFAULTS = {
  allowJs: true,
  skipLibCheck: true,
  esModuleInterop: true,
  allowSyntheticDefaultImports: true,
};

export function mapCompilerOptions(tsconfigText: string | null, ts: any): any {
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
      "baseUrl",
    ]) {
      if (co[key] !== undefined) base[key] = co[key];
    }
    return base;
  } catch {
    return base;
  }
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
