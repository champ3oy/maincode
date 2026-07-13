import { useEffect, useRef } from "react";
import "@xterm/xterm/css/xterm.css";
import { invoke } from "@tauri-apps/api/core";
import { useSettings } from "@/hooks/use-settings";
import { acquireSession, detachSession, getSession } from "./terminal-sessions";

interface TerminalPanelProps {
  id: number;
  cwd: string;
}

// Thin shell over a persistent terminal session. On mount it acquires (or
// re-attaches) the session for `id`; on unmount it detaches the xterm's DOM
// element but keeps the session (pty + scrollback) alive.
export function TerminalPanel({ id, cwd }: TerminalPanelProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const { settings } = useSettings();
  const { fontSize } = settings.terminal;

  // Keep a ref to the current fontSize so the setup effect can read the latest
  // value at acquire time without re-running when the setting changes.
  const fontSizeRef = useRef(fontSize);
  fontSizeRef.current = fontSize;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const session = acquireSession(id, cwd, host, fontSizeRef.current);
    session.term.focus();

    const ro = new ResizeObserver(() => {
      session.fit.fit();
      if (session.ptyId !== null) {
        void invoke("pty_resize", {
          id: session.ptyId,
          cols: session.term.cols,
          rows: session.term.rows,
        });
      }
    });
    ro.observe(host);

    return () => {
      ro.disconnect();
      detachSession(id); // keep the session alive; just remove its DOM
    };
  }, [id, cwd]);

  // Update the live terminal font size when the setting changes.
  useEffect(() => {
    const session = getSession(id);
    if (!session) return;
    session.term.options.fontSize = fontSize;
    session.fit.fit();
    if (session.ptyId !== null) {
      void invoke("pty_resize", {
        id: session.ptyId,
        cols: session.term.cols,
        rows: session.term.rows,
      });
    }
  }, [id, fontSize]);

  return <div ref={hostRef} className="h-full w-full px-2 pt-1" />;
}
