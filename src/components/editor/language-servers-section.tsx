import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface ServerStatus {
  server_id: string;
  label: string;
  languages: string[];
  kind: "bundled" | "github-release" | "go-install";
  state: "builtin" | "installed" | "missing";
}

/** Friendly label for a raw `lsp-install-<id>` progress phase. */
const PHASE_LABEL: Record<string, string> = {
  download: "Downloading…",
  extract: "Extracting…",
  install: "Installing…",
};
const phaseLabel = (phase: string) => PHASE_LABEL[phase] ?? "Installing…";

export function LanguageServersSection() {
  const [servers, setServers] = useState<ServerStatus[]>([]);
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  const refresh = () => void invoke<ServerStatus[]>("lsp_server_status").then(setServers).catch(() => {});
  useEffect(() => { refresh(); }, []);
  useEffect(() => {
    const uns = servers.map((s) =>
      listen<{ phase: string }>(`lsp-install-${s.server_id}`, (e) => {
        setBusy((b) => ({ ...b, [s.server_id]: e.payload.phase }));
        if (e.payload.phase === "done") { setBusy((b) => { const n = { ...b }; delete n[s.server_id]; return n; }); refresh(); }
      }),
    );
    return () => { void Promise.all(uns).then((fns) => fns.forEach((f) => f())); };
  }, [servers]);

  // Acquisition runs on a background thread in Rust, so this returns immediately
  // and the "Installing…" state paints without freezing the UI. `kind` seeds a
  // sensible first label (go compiles rather than downloads) before the first
  // progress event arrives.
  const install = (id: string, kind: string) => {
    setErrors((e) => { const n = { ...e }; delete n[id]; return n; });
    setBusy((b) => ({ ...b, [id]: kind === "go-install" ? "install" : "download" }));
    void invoke("lsp_ensure_server", { serverId: id })
      .then(refresh)
      .catch((err) => {
        setBusy((b) => { const n = { ...b }; delete n[id]; return n; });
        setErrors((e) => ({ ...e, [id]: String(err) }));
      });
  };
  const remove = (id: string) => void invoke("lsp_remove_server", { serverId: id }).then(refresh).catch(() => {});

  return (
    <div className="flex flex-col gap-2">
      {servers.map((s) => (
        <div key={s.server_id} className="flex items-center justify-between gap-4 rounded-md border border-border px-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">{s.label}</p>
            <p className="text-xs text-muted-foreground mt-0.5">.{s.languages.join(", .")}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2 text-xs">
            {busy[s.server_id] ? (
              <span className="animate-pulse text-muted-foreground">{phaseLabel(busy[s.server_id])}</span>
            ) : s.state === "builtin" ? (
              <span className="rounded border border-border px-2 py-1 text-muted-foreground">Built-in</span>
            ) : (
              <>
                {errors[s.server_id] ? (
                  <span className="max-w-[16rem] truncate text-destructive" title={errors[s.server_id]}>
                    {errors[s.server_id]}
                  </span>
                ) : null}
                {s.state === "installed" ? (
                  <button className="rounded border border-border px-2.5 py-1 hover:bg-accent" onClick={() => remove(s.server_id)}>Remove</button>
                ) : (
                  <button className="rounded border border-border px-2.5 py-1 hover:bg-accent" onClick={() => install(s.server_id, s.kind)}>
                    {errors[s.server_id] ? "Retry" : "Install"}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
