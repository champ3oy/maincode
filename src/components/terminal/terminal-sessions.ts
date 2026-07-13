import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface Session {
  term: Terminal;
  fit: FitAddon;
  ptyId: number | null; // null until pty_spawn resolves
  unlistenOut: (() => void) | null;
  unlistenExit: (() => void) | null;
  dataSub: { dispose(): void } | null;
  disposed: boolean;
}

// Module-level store: survives component unmount. Each Tauri webview window has
// its own JS context, so this map is naturally per-window (no cross-window
// collision).
const sessions = new Map<number, Session>();

// --- persistent split list (survives dock unmount) ---
let splitIds: number[] = [0];
let nextId = 1;

export function getSplitIds(): number[] {
  return splitIds.length ? splitIds : [0];
}

export function setSplitIds(ids: number[]): void {
  splitIds = ids;
}

export function allocSplitId(): number {
  return nextId++;
}

// Called when the dock mounts, so nextId never collides with a persisted id.
export function syncNextId(): void {
  nextId = Math.max(0, ...splitIds, nextId - 1) + 1;
}

// --- session lifecycle ---
export function acquireSession(
  id: number,
  cwd: string,
  host: HTMLElement,
  fontSize: number,
): Session {
  const existing = sessions.get(id);
  if (existing) {
    // Re-attach the persisted xterm's element into the fresh host. term.open()
    // was already called once at creation, so we only re-parent the element.
    const el = existing.term.element;
    if (el && el.parentElement !== host) host.appendChild(el);
    // Defer the fit + repaint to the next frame: the re-parented element has no
    // layout yet in this tick, so a synchronous fit measures 0/stale dimensions
    // and leaves the renderer glitched until a manual resize. After a frame the
    // host has real dimensions, so we cache the terminal's current size, force a
    // dimension change (a resize xterm can't no-op away — that's what a manual
    // drag does), fit to the true size, and repaint every row.
    requestAnimationFrame(() => {
      if (existing.disposed || !existing.term.element) return;
      const { cols, rows } = existing.term;
      existing.term.resize(Math.max(1, cols), Math.max(1, rows === 1 ? 2 : rows - 1));
      existing.fit.fit();
      existing.term.refresh(0, existing.term.rows - 1);
    });
    return existing;
  }

  const term = new Terminal({
    fontSize,
    fontFamily: '"App Mono", ui-monospace, monospace',
    cursorBlink: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host); // creates term.element inside host (call ONCE ever)
  fit.fit();

  const s: Session = {
    term,
    fit,
    ptyId: null,
    unlistenOut: null,
    unlistenExit: null,
    dataSub: null,
    disposed: false,
  };
  sessions.set(id, s);

  invoke<number>("pty_spawn", { cwd, cols: term.cols, rows: term.rows })
    .then(async (ptyId) => {
      const [unOut, unExit] = await Promise.all([
        listen<string>(`pty-output-${ptyId}`, (e) => term.write(e.payload)),
        listen(`pty-exit-${ptyId}`, () =>
          term.write("\r\n[process exited]\r\n"),
        ),
      ]);
      if (s.disposed) {
        unOut();
        unExit();
        void invoke("pty_kill", { id: ptyId });
        return;
      }
      s.ptyId = ptyId;
      s.unlistenOut = unOut;
      s.unlistenExit = unExit;
    })
    .catch((e) => term.write(`\r\nfailed to start shell: ${e}\r\n`));

  s.dataSub = term.onData((data) => {
    if (s.ptyId !== null) void invoke("pty_write", { id: s.ptyId, data });
  });

  return s;
}

export function getSession(id: number): Session | undefined {
  return sessions.get(id);
}

// Remove the xterm's element from the DOM but keep the session alive (hide).
// Listeners persist, so pty output keeps buffering into the xterm while hidden.
export function detachSession(id: number): void {
  const s = sessions.get(id);
  const el = s?.term.element;
  if (el && el.parentElement) el.parentElement.removeChild(el);
}

// Fully destroy a session (explicit close): kill pty, dispose xterm, forget it.
export function disposeSession(id: number): void {
  const s = sessions.get(id);
  if (!s) return;
  s.disposed = true;
  s.dataSub?.dispose();
  s.unlistenOut?.();
  s.unlistenExit?.();
  if (s.ptyId !== null) void invoke("pty_kill", { id: s.ptyId });
  s.term.dispose();
  sessions.delete(id);
}
