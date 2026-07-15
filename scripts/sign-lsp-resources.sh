#!/usr/bin/env bash
# Codesign the bundled LSP resource binaries (the Node runtime + native .node
# addons) with the Developer ID + hardened runtime + a secure timestamp, so the
# app passes Apple notarization. Tauri signs the main binary but NOT bundled
# resource binaries, so notarization otherwise rejects them ("binary is not
# signed"). Run automatically via tauri.conf's beforeBundleCommand.
set -euo pipefail

IDENTITY="${MACOS_SIGN_IDENTITY:-Developer ID Application: Deadalus Systems (F77F7X4Q2W)}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LSP="$ROOT/resources/lsp"
NODE_ENT="$ROOT/src-tauri/entitlements-node.plist"

if [ ! -d "$LSP" ]; then
  echo "sign-lsp-resources: $LSP not found (run scripts/fetch-lsp.mjs first)" >&2
  exit 1
fi

# The Node runtime: needs JIT / library-validation entitlements to run under the
# hardened runtime.
if [ -f "$LSP/node" ]; then
  codesign --force --options runtime --timestamp \
    --entitlements "$NODE_ENT" --sign "$IDENTITY" "$LSP/node"
  echo "signed: resources/lsp/node"
fi

# Native addons (*.node): hardened runtime + timestamp, no entitlements needed.
find "$LSP" -type f -name "*.node" -print0 | while IFS= read -r -d '' f; do
  codesign --force --options runtime --timestamp --sign "$IDENTITY" "$f"
  echo "signed: ${f#"$ROOT/"}"
done

echo "sign-lsp-resources: done"
