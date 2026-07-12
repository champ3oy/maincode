export type LanguageKey =
  | "javascript"
  | "jsx"
  | "typescript"
  | "tsx"
  | "python"
  | "html"
  | "css"
  | "json"
  | "markdown"
  | "rust"
  | "yaml";

const EXT_TO_KEY: Record<string, LanguageKey> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  py: "python",
  html: "html",
  htm: "html",
  css: "css",
  json: "json",
  md: "markdown",
  markdown: "markdown",
  rs: "rust",
  yml: "yaml",
  yaml: "yaml",
};

export const LANGUAGE_LABELS: Record<LanguageKey, string> = {
  javascript: "JavaScript",
  jsx: "JSX",
  typescript: "TypeScript",
  tsx: "TSX",
  python: "Python",
  html: "HTML",
  css: "CSS",
  json: "JSON",
  markdown: "Markdown",
  rust: "Rust",
  yaml: "YAML",
};

export function languageKeyForPath(path: string): LanguageKey | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return EXT_TO_KEY[ext] ?? null;
}
