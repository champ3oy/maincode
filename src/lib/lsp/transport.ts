import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** A raw JSON-message pipe to one LSP server session. */
export interface Transport {
  send(message: string): Promise<void>;
  onMessage(cb: (message: string) => void): () => void;
  onExit(cb: () => void): () => void;
  dispose(): void;
}

/** Spawn a server for `root` and return a Transport bound to its session id. */
export async function spawnServer(root: string): Promise<{ id: number; transport: Transport }> {
  const id = await invoke<number>("lsp_spawn", { root });
  const msgListeners = new Set<(m: string) => void>();
  const exitListeners = new Set<() => void>();
  const unlisten: UnlistenFn[] = [];

  void listen<string>(`lsp-msg-${id}`, (e) => msgListeners.forEach((cb) => cb(e.payload))).then(
    (u) => unlisten.push(u),
  );
  void listen(`lsp-exit-${id}`, () => exitListeners.forEach((cb) => cb())).then((u) =>
    unlisten.push(u),
  );

  const transport: Transport = {
    send: (message) => invoke("lsp_send", { id, message }),
    onMessage(cb) {
      msgListeners.add(cb);
      return () => msgListeners.delete(cb);
    },
    onExit(cb) {
      exitListeners.add(cb);
      return () => exitListeners.delete(cb);
    },
    dispose() {
      unlisten.forEach((u) => u());
      void invoke("lsp_stop", { id }).catch(() => {});
    },
  };
  return { id, transport };
}
