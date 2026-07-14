import { languageKeyForPath, type LanguageKey } from "../language";
import { LspClient } from "./client";
import type { IntelligenceClient } from "../intelligence";

const SERVER_FOR_LANG: Partial<Record<LanguageKey, string>> = {
  typescript: "typescript",
  tsx: "typescript",
  javascript: "typescript",
  jsx: "typescript",
  python: "python",
  rust: "rust",
  go: "go",
  c: "cpp",
  cpp: "cpp",
  shell: "bash",
  yaml: "yaml",
  json: "json",
  html: "html",
  css: "css",
  dockerfile: "dockerfile",
  svelte: "svelte",
  graphql: "graphql",
  vue: "vue",
};

export function serverIdForPath(path: string): string | null {
  const key = languageKeyForPath(path);
  return key ? (SERVER_FOR_LANG[key] ?? null) : null;
}

/** Factory so tests can inject a fake client builder. */
export function makeManager(build: (serverId: string) => IntelligenceClient) {
  let root: string | null = null;
  const clients = new Map<string, IntelligenceClient>();
  return {
    setProjectRoot(next: string | null) {
      if (next === root) return;
      for (const c of clients.values()) c.closeProject();
      clients.clear();
      root = next;
    },
    hasLspServer(path: string): boolean {
      return serverIdForPath(path) !== null;
    },
    clientForPath(path: string): IntelligenceClient | null {
      const serverId = serverIdForPath(path);
      if (!serverId || !root) return null;
      let client = clients.get(serverId);
      if (!client) {
        client = build(serverId);
        clients.set(serverId, client);
        void client.openProject(root).catch(() => {});
      }
      return client;
    },
  };
}

const manager = makeManager((serverId) => new LspClient(serverId));
export const setProjectRoot = manager.setProjectRoot;
export const clientForPath = manager.clientForPath;
export const hasLspServer = manager.hasLspServer;
