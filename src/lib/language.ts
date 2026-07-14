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
  | "yaml"
  | "toml"
  | "ini"
  | "shell"
  | "dockerfile"
  | "xml"
  | "sql"
  | "c"
  | "cpp"
  | "java"
  | "kotlin"
  | "csharp"
  | "go"
  | "ruby"
  | "lua"
  | "swift"
  | "diff";

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
  pyi: "python",
  html: "html",
  htm: "html",
  css: "css",
  json: "json",
  jsonc: "json",
  md: "markdown",
  markdown: "markdown",
  rs: "rust",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  properties: "ini",
  env: "ini",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  ksh: "shell",
  xml: "xml",
  svg: "xml",
  xsl: "xml",
  xslt: "xml",
  plist: "xml",
  sql: "sql",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  cs: "csharp",
  go: "go",
  rb: "ruby",
  gemspec: "ruby",
  rake: "ruby",
  lua: "lua",
  swift: "swift",
  diff: "diff",
  patch: "diff",
};

// Whole-filename matches for extension-less files and common dotfiles that have
// no "name.ext" shape.
const NAME_TO_KEY: Record<string, LanguageKey> = {
  dockerfile: "dockerfile",
  ".env": "ini",
  ".editorconfig": "ini",
  ".npmrc": "ini",
  ".yarnrc": "ini",
  ".gitconfig": "ini",
  ".bashrc": "shell",
  ".bash_profile": "shell",
  ".bash_aliases": "shell",
  ".zshrc": "shell",
  ".zshenv": "shell",
  ".zprofile": "shell",
  ".profile": "shell",
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
  toml: "TOML",
  ini: "INI",
  shell: "Shell",
  dockerfile: "Dockerfile",
  xml: "XML",
  sql: "SQL",
  c: "C",
  cpp: "C++",
  java: "Java",
  kotlin: "Kotlin",
  csharp: "C#",
  go: "Go",
  ruby: "Ruby",
  lua: "Lua",
  swift: "Swift",
  diff: "Diff",
};

export function languageKeyForPath(path: string): LanguageKey | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const lower = name.toLowerCase();
  // Whole-name matches first: extension-less files (Dockerfile) and dotfiles
  // (.env, .bashrc, …) that have no "name.ext" shape.
  if (NAME_TO_KEY[lower]) return NAME_TO_KEY[lower];
  if (lower.startsWith(".env.")) return "ini"; // .env.local, .env.production, …
  if (lower.endsWith(".dockerfile")) return "dockerfile";
  // Extension (a leading-dot dotfile with a known extension still resolves here).
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return EXT_TO_KEY[ext] ?? null;
}
