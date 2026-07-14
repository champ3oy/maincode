/**
 * Classify a file path by its extension into the script kind the editor's
 * language features care about. `"other"` means it's not a TS/JS-family file.
 */
export function scriptKindForPath(path: string): "ts" | "tsx" | "js" | "jsx" | "other" {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "ts" || ext === "mts" || ext === "cts") return "ts";
  if (ext === "tsx") return "tsx";
  if (ext === "js" || ext === "mjs" || ext === "cjs") return "js";
  if (ext === "jsx") return "jsx";
  return "other";
}
