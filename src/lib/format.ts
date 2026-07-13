/**
 * Prettier formatting utilities — lazy-loaded so prettier never enters the
 * main bundle.  All dynamic imports are cached after first load.
 */

import type { EditorView } from "@codemirror/view";
import { readFile } from "@/lib/fs";

// ---------------------------------------------------------------------------
// Module cache — filled on first use, reused thereafter.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyModule = any;
const moduleCache = new Map<string, AnyModule>();

// Literal import() specifiers so Vite code-splits each module into its own
// lazily-fetched chunk. (A variable specifier with @vite-ignore would skip
// bundling entirely and fail at runtime — webviews can't resolve bare
// specifiers.)
const loaders = {
  "prettier/standalone": () => import("prettier/standalone"),
  "prettier/plugins/babel": () => import("prettier/plugins/babel"),
  "prettier/plugins/estree": () => import("prettier/plugins/estree"),
  "prettier/plugins/typescript": () => import("prettier/plugins/typescript"),
  "prettier/plugins/postcss": () => import("prettier/plugins/postcss"),
  "prettier/plugins/html": () => import("prettier/plugins/html"),
  "prettier/plugins/markdown": () => import("prettier/plugins/markdown"),
  "prettier/plugins/yaml": () => import("prettier/plugins/yaml"),
} as const;

type ModuleSpecifier = keyof typeof loaders;

async function loadModule(specifier: ModuleSpecifier): Promise<AnyModule> {
  if (moduleCache.has(specifier)) return moduleCache.get(specifier);
  const mod = await loaders[specifier]();
  moduleCache.set(specifier, mod);
  return mod;
}

// ---------------------------------------------------------------------------
// Parser inference
// ---------------------------------------------------------------------------

interface ParserResult {
  parser: string;
  plugins: ModuleSpecifier[];
}

export function inferParser(filePath: string): ParserResult | null {
  const ext = filePath.slice(filePath.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return { parser: "babel", plugins: ["prettier/plugins/babel", "prettier/plugins/estree"] };
    case "ts":
    case "tsx":
    case "mts":
    case "cts":
      return { parser: "typescript", plugins: ["prettier/plugins/typescript", "prettier/plugins/estree"] };
    case "json":
    case "jsonc":
      return { parser: "json", plugins: ["prettier/plugins/babel", "prettier/plugins/estree"] };
    case "json5":
      return { parser: "json5", plugins: ["prettier/plugins/babel", "prettier/plugins/estree"] };
    case "css":
      return { parser: "css", plugins: ["prettier/plugins/postcss"] };
    case "scss":
      return { parser: "scss", plugins: ["prettier/plugins/postcss"] };
    case "less":
      return { parser: "less", plugins: ["prettier/plugins/postcss"] };
    case "html":
      return {
        parser: "html",
        plugins: [
          "prettier/plugins/html",
          "prettier/plugins/babel",
          "prettier/plugins/estree",
          "prettier/plugins/postcss",
        ],
      };
    case "md":
    case "markdown":
      return {
        parser: "markdown",
        plugins: ["prettier/plugins/markdown", "prettier/plugins/babel", "prettier/plugins/estree"],
      };
    case "yml":
    case "yaml":
      return { parser: "yaml", plugins: ["prettier/plugins/yaml"] };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Config cache — keyed by rootPath string (null → "")
// ---------------------------------------------------------------------------

const configCache = new Map<string, object>();

export function clearPrettierConfigCache(): void {
  configCache.clear();
}

/**
 * Resolve a Prettier config from the project root.  Only JSON-based configs
 * (.prettierrc, .prettierrc.json, package.json#prettier) are supported.
 * JS/YAML configs silently fall back to defaults (v1 limit).
 */
export async function resolvePrettierConfig(rootPath: string | null): Promise<object> {
  const key = rootPath ?? "";
  if (configCache.has(key)) return configCache.get(key)!;

  if (!rootPath) {
    configCache.set(key, {});
    return {};
  }

  // Try .prettierrc (may be JSON)
  for (const name of [".prettierrc", ".prettierrc.json"]) {
    try {
      const result = await readFile(`${rootPath}/${name}`);
      if (result.content !== null) {
        const parsed = JSON.parse(result.content);
        configCache.set(key, parsed);
        return parsed;
      }
    } catch {
      // parse failure or file not found → try next
    }
  }

  // Try package.json#prettier
  try {
    const result = await readFile(`${rootPath}/package.json`);
    if (result.content !== null) {
      const pkg = JSON.parse(result.content) as Record<string, unknown>;
      if (pkg["prettier"] && typeof pkg["prettier"] === "object") {
        const cfg = pkg["prettier"] as object;
        configCache.set(key, cfg);
        return cfg;
      }
    }
  } catch {
    // ignore
  }

  configCache.set(key, {});
  return {};
}

// ---------------------------------------------------------------------------
// format (plain text, no cursor) — used by use-editor content-level path
// ---------------------------------------------------------------------------

/**
 * Format `content` for `filePath`.  Returns the formatted string, or null
 * if no parser is available for this file type.  Throws a readable Error on
 * syntax errors (callers should toast it).
 */
export async function formatContent(
  content: string,
  filePath: string,
  options: object,
): Promise<string | null> {
  const info = inferParser(filePath);
  if (!info) return null;

  const [prettier, ...pluginModules] = await Promise.all([
    loadModule("prettier/standalone"),
    ...info.plugins.map((p) => loadModule(p)),
  ]);

  try {
    const formatted: string = await prettier.format(content, {
      parser: info.parser,
      plugins: pluginModules,
      ...options,
    });
    return formatted;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(msg);
  }
}

// ---------------------------------------------------------------------------
// formatWithCursorInView — used by code-editor ⇧⌥F path (cursor preserved)
// ---------------------------------------------------------------------------

/**
 * Format the document in `view` for the given `filePath`, preserving the
 * cursor position.  Dispatches a single replace-all transaction so undo works.
 * Returns false if no parser is available.  Throws on syntax errors.
 */
export async function formatWithCursorInView(
  view: EditorView,
  filePath: string,
  options: object,
): Promise<boolean> {
  const info = inferParser(filePath);
  if (!info) return false;

  const [prettier, ...pluginModules] = await Promise.all([
    loadModule("prettier/standalone"),
    ...info.plugins.map((p) => loadModule(p)),
  ]);

  const docStr = view.state.doc.toString();
  const cursorOffset = view.state.selection.main.head;

  let formatted: string;
  let newCursorOffset: number;

  try {
    const result = await prettier.formatWithCursor(docStr, {
      parser: info.parser,
      plugins: pluginModules,
      cursorOffset,
      ...options,
    }) as { formatted: string; cursorOffset: number };
    formatted = result.formatted;
    newCursorOffset = result.cursorOffset;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(msg);
  }

  // No-op if content unchanged (still return true — success).
  if (formatted === docStr) return true;

  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: formatted },
    selection: { anchor: Math.min(newCursorOffset, formatted.length) },
    scrollIntoView: true,
  });

  return true;
}
