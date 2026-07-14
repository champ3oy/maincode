import { scriptKindForPath } from "./mapping";

/**
 * True for paths the TypeScript/JS intelligence engine handles (ts/tsx/js/jsx/
 * mjs/cjs/mts/cts). Used to gate the editor's language features on a per-file
 * basis. (Historical name — the intelligence engine is now the LSP server.)
 */
export function isTsWorkerPath(path: string): boolean {
  return scriptKindForPath(path) !== "other";
}
