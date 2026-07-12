import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface TerminalPanelProps {
  cwd: string;
}

export function TerminalPanel({ cwd }: TerminalPanelProps) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontSize: 12,
      fontFamily: '"App Mono", ui-monospace, monospace',
      cursorBlink: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    let id: number | null = null;
    let unlistenOut: (() => void) | null = null;
    let unlistenExit: (() => void) | null = null;
    let disposed = false;

    invoke<number>("pty_spawn", { cwd, cols: term.cols, rows: term.rows })
      .then(async (ptyId) => {
        if (disposed) {
          void invoke("pty_kill", { id: ptyId });
          return;
        }
        id = ptyId;
        unlistenOut = await listen<string>(`pty-output-${ptyId}`, (e) =>
          term.write(e.payload),
        );
        unlistenExit = await listen(`pty-exit-${ptyId}`, () =>
          term.write("\r\n[process exited]\r\n"),
        );
      })
      .catch((e) => term.write(`\r\nfailed to start shell: ${e}\r\n`));

    const dataSub = term.onData((data) => {
      if (id !== null) void invoke("pty_write", { id, data });
    });

    const ro = new ResizeObserver(() => {
      fit.fit();
      if (id !== null) {
        void invoke("pty_resize", { id, cols: term.cols, rows: term.rows });
      }
    });
    ro.observe(host);

    return () => {
      disposed = true;
      ro.disconnect();
      dataSub.dispose();
      unlistenOut?.();
      unlistenExit?.();
      if (id !== null) void invoke("pty_kill", { id });
      term.dispose();
    };
  }, [cwd]);

  return <div ref={hostRef} className="h-full w-full px-2 pt-1" />;
}
