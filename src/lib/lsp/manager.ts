import { languageKeyForPath, type LanguageKey } from "../language";
import { LspClient } from "./client";
import type { IntelligenceClient, LspProgress, LspProgressEvent } from "../intelligence";

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
  const progressByServer = new Map<string, LspProgress>();
  const progressListeners = new Set<(p: LspProgressEvent | null) => void>();

  const emitProgress = () => {
    // Surface the most-recently-updated server's progress (Map preserves order;
    // re-insertion below moves the active one last).
    const entries = [...progressByServer.entries()];
    const last = entries[entries.length - 1];
    const evt = last ? { serverId: last[0], ...last[1] } : null;
    progressListeners.forEach((fn) => fn(evt));
  };

  // Create (or reuse) the one client for a serverId, opening the project and
  // wiring its progress into the manager-level stream.
  const getOrCreate = (serverId: string): IntelligenceClient | null => {
    if (!root) return null;
    let client = clients.get(serverId);
    if (!client) {
      client = build(serverId);
      clients.set(serverId, client);
      client.onProgress?.((p) => {
        progressByServer.delete(serverId);
        if (p) progressByServer.set(serverId, p);
        emitProgress();
      });
      void client.openProject(root).catch(() => {});
    }
    return client;
  };

  return {
    setProjectRoot(next: string | null) {
      if (next === root) return;
      for (const c of clients.values()) c.closeProject();
      clients.clear();
      progressByServer.clear();
      emitProgress();
      root = next;
    },
    hasLspServer(path: string): boolean {
      return serverIdForPath(path) !== null;
    },
    clientForPath(path: string): IntelligenceClient | null {
      const serverId = serverIdForPath(path);
      if (!serverId) return null;
      return getOrCreate(serverId);
    },
    /** Eagerly start a server (e.g. rust-analyzer on project open) so its slow
     *  first index runs in the background before the user opens a file. */
    warmServer(serverId: string) {
      getOrCreate(serverId);
    },
    /** Subscribe to language-server progress across all servers. */
    onLspProgress(fn: (p: LspProgressEvent | null) => void): () => void {
      progressListeners.add(fn);
      return () => progressListeners.delete(fn);
    },
  };
}

const manager = makeManager((serverId) => new LspClient(serverId));
export const setProjectRoot = manager.setProjectRoot;
export const clientForPath = manager.clientForPath;
export const hasLspServer = manager.hasLspServer;
export const warmServer = manager.warmServer;
export const onLspProgress = manager.onLspProgress;
