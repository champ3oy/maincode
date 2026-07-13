import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";

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
      // Enable the kitty keyboard protocol (off by default in xterm.js 6.1) so
      // apps that negotiate it (e.g. Claude Code) get a distinct Shift+Enter and
      // all other modified keys, instead of Shift+Enter reading as plain Enter.
      vtExtensions: { kittyKeyboard: true },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // Make URLs printed in the terminal clickable — opened in the default
    // browser (not the app webview) via Tauri's opener.
    term.loadAddon(
      new WebLinksAddon((_event, uri) => {
        void openUrl(uri);
      }),
    );
    term.open(host);
    fit.fit();

    // TEMP diagnostic (remove once Shift+Enter is confirmed): proves which
    // build is running and whether the kitty option is live on this instance.
    console.log(
      "[maincode-kbd] mount: kittyKeyboard =",
      term.options.vtExtensions?.kittyKeyboard,
    );

    let id: number | null = null;
    let unlistenOut: (() => void) | null = null;
    let unlistenExit: (() => void) | null = null;
    let disposed = false;

    invoke<number>("pty_spawn", { cwd, cols: term.cols, rows: term.rows })
      .then(async (ptyId) => {
        const [unOut, unExit] = await Promise.all([
          listen<string>(`pty-output-${ptyId}`, (e) => {
            // TEMP diagnostic: log kitty negotiation the app (e.g. claude) sends.
            const seqs = e.payload.match(/\x1b\[[?>=<][0-9;]*u/g);
            if (seqs) console.log("[maincode-kbd] app→term kitty:", seqs);
            term.write(e.payload);
          }),
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
        unlistenOut = unOut;
        unlistenExit = unExit;
      })
      .catch((e) => term.write(`\r\nfailed to start shell: ${e}\r\n`));

    const dataSub = term.onData((data) => {
      // TEMP diagnostic: what xterm sends to the PTY. On Shift+Enter this should
      // be "\x1b[13;2u" when kitty is active, not "\r".
      console.log("[maincode-kbd] term→pty:", JSON.stringify(data));
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
