// @vitest-environment jsdom
//
// Reproduction + regression test for the "stale red squiggles never clear"
// bug (feat/ts-worker). Mounts a REAL EditorView with a lint compartment
// holding an async linter whose backing diagnostics flip from [1 error] to []
// (simulating the TS worker converging as types load).
//
// The bug: after the initial async lint applies the error and the editor goes
// idle, calling `forceLinting(view)` does NOT re-run the linter, so the stale
// error persists. Root cause lives in @codemirror/lint's LintPlugin.force():
//
//     force() { if (this.set) { this.lintTime = Date.now(); this.run(); } }
//
// `this.set` is only true while a lint is scheduled/pending. Once the initial
// lint applies and no doc change re-schedules one, `this.set` is false, so
// `force()` (and therefore `forceLinting`) is a complete no-op.
//
// The fix reconfigures the lint compartment with a freshly-built `linter(...)`
// instance, which tears down the old lint plugin and installs a new one whose
// first update schedules + runs a fresh lint against the converged data.

import { afterEach, describe, expect, it } from "vitest";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  diagnosticCount,
  forceLinting,
  linter,
  lintGutter,
  type Diagnostic,
} from "@codemirror/lint";

// Mirror code-editor.tsx's lint delay so timing matches production.
const LINT_DELAY = 250;

/** Wait for the lint plugin's scheduled run + async source + dispatch to settle. */
async function flushLint(extra = 0): Promise<void> {
  await new Promise((r) => setTimeout(r, LINT_DELAY + 60 + extra));
  // Drain any trailing microtasks (the async source resolves via Promise).
  await Promise.resolve();
  await Promise.resolve();
}

/**
 * Builds a lint extension backed by a mutable holder. The async source mimics
 * the TS worker: it returns whatever diagnostics the holder currently carries.
 */
function makeLintExtension(holder: { diags: Diagnostic[] }) {
  return [
    lintGutter(),
    linter(
      async () => {
        // async, like the intelligence client's getDiagnostics(path)
        await Promise.resolve();
        return holder.diags;
      },
      { delay: LINT_DELAY },
    ),
  ];
}

function errorDiag(): Diagnostic {
  return { from: 0, to: 3, severity: "error", message: "Cannot find module 'x'" };
}

let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
});

describe("lint refresh on types-loaded", () => {
  it("REPRO: forceLinting does NOT clear a stale error once the editor is idle", async () => {
    const holder = { diags: [errorDiag()] };
    const lintCompartment = new Compartment();
    view = new EditorView({
      state: EditorState.create({
        doc: "import x from 'x';\n",
        extensions: [lintCompartment.of(makeLintExtension(holder))],
      }),
      parent: document.body,
    });

    // 1. Initial async lint applies the error.
    await flushLint();
    expect(diagnosticCount(view.state)).toBe(1);

    // 2. Types "load": backing data flips to clean, then we forceLinting exactly
    //    as the old code-editor onTypesUpdated handler did (no doc change).
    holder.diags = [];
    forceLinting(view);
    await flushLint();

    // BUG: the error is still there. forceLinting was a no-op because the lint
    // plugin was idle (`this.set === false`) with no pending run to force.
    expect(diagnosticCount(view.state)).toBe(1);
  });

  it("FIX: reconfiguring the lint compartment with a fresh linter clears the stale error", async () => {
    const holder = { diags: [errorDiag()] };
    const lintCompartment = new Compartment();
    view = new EditorView({
      state: EditorState.create({
        doc: "import x from 'x';\n",
        extensions: [lintCompartment.of(makeLintExtension(holder))],
      }),
      parent: document.body,
    });

    // Initial async lint applies the error.
    await flushLint();
    expect(diagnosticCount(view.state)).toBe(1);

    // Types "load": flip backing data to clean, then RECONFIGURE the lint
    // compartment with a freshly-built lint extension (new linter instance).
    holder.diags = [];
    view.dispatch({
      effects: lintCompartment.reconfigure(makeLintExtension(holder)),
    });
    await flushLint();

    // The fresh linter re-ran against the converged data and cleared the error.
    expect(diagnosticCount(view.state)).toBe(0);
  });
});
