import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSettings } from "@/hooks/use-settings";

interface TerminalPanelProps {
  cwd: string;
}

export function TerminalPanel({ cwd }: TerminalPanelProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const { settings } = useSettings();
  const { fontSize } = settings.terminal;

  // Keep a ref to the current fontSize so the PTY effect can read the latest
  // value without re-running the heavy setup effect.
  const fontSizeRef = useRef(fontSize);
  fontSizeRef.current = fontSize;

  // Refs to the live term + fit so the font-size effect can update them.
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const ptyIdRef = useRef<number | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontSize: fontSizeRef.current,
      fontFamily: '"App Mono", ui-monospace, monospace',
      cursorBlink: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    termRef.current = term;
    fitRef.current = fit;

    let id: number | null = null;
    let unlistenOut: (() => void) | null = null;
    let unlistenExit: (() => void) | null = null;
    let disposed = false;

    invoke<number>("pty_spawn", { cwd, cols: term.cols, rows: term.rows })
      .then(async (ptyId) => {
        const [unOut, unExit] = await Promise.all([
          listen<string>(`pty-output-${ptyId}`, (e) => term.write(e.payload)),
          listen(`pty-exit-${ptyId}`, () =>
            term.write("\r\n[process exited]\r\n"),
          ),
        ]);
        if (disposed) {
          unOut();
          unExit();
          void invoke("pty_kill", { id: ptyId });
          return;
        }
        id = ptyId;
        ptyIdRef.current = ptyId;
        unlistenOut = unOut;
        unlistenExit = unExit;
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
      ptyIdRef.current = null;
      termRef.current = null;
      fitRef.current = null;
      ro.disconnect();
      dataSub.dispose();
      unlistenOut?.();
      unlistenExit?.();
      if (id !== null) void invoke("pty_kill", { id });
      term.dispose();
    };
  }, [cwd]);

  // Update the live terminal font size when the setting changes.
  useEffect(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    term.options.fontSize = fontSize;
    fit.fit();
    const ptyId = ptyIdRef.current;
    if (ptyId !== null) {
      void invoke("pty_resize", { id: ptyId, cols: term.cols, rows: term.rows });
    }
  }, [fontSize]);

  return <div ref={hostRef} className="h-full w-full px-2 pt-1" />;
}
