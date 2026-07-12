#!/bin/sh
# Signed (+ notarized) macOS release build for Maincode.
#
# SIGNING: uses the "Developer ID Application" identity set in
# src-tauri/tauri.conf.json — it must be present in your login keychain.
#
# NOTARIZATION: export these first, then re-run. The password is an
# *app-specific password* from https://appleid.apple.com
# (Sign-In & Security → App-Specific Passwords). The Apple ID must belong to
# the signing team (Deadalus Systems, F77F7X4Q2W).
#
#   export APPLE_ID="you@example.com"
#   export APPLE_PASSWORD="xxxx-xxxx-xxxx-xxxx"
#   export APPLE_TEAM_ID="F77F7X4Q2W"
#
# When those are set, Tauri notarizes with Apple and staples the ticket.
set -e
cd "$(dirname "$0")/.."

if [ -n "$APPLE_ID" ] && [ -n "$APPLE_PASSWORD" ] && [ -n "$APPLE_TEAM_ID" ]; then
  echo "→ SIGNED + NOTARIZED build (uploads to Apple; usually a few minutes)…"
else
  echo "→ SIGNED-only build (no notarization creds in the environment)."
  echo "  To notarize: export APPLE_ID / APPLE_PASSWORD (app-specific) / APPLE_TEAM_ID, then re-run."
fi

bun run tauri build

APP="src-tauri/target/release/bundle/macos/Maincode.app"
echo "→ Verifying…"
codesign --verify --deep --strict "$APP" && echo "  signature: OK"
if spctl -a -vvv --type exec "$APP" 2>&1 | grep -q accepted; then
  echo "  Gatekeeper: ACCEPTED — notarized ✅"
else
  echo "  Gatekeeper: not notarized (signed only)."
fi

# Tauri notarizes the .app but leaves the .dmg wrapper merely signed. Staple the
# DMG too so downloaders don't hit a Gatekeeper prompt on the disk image itself.
if [ -n "$APPLE_ID" ] && [ -n "$APPLE_PASSWORD" ] && [ -n "$APPLE_TEAM_ID" ]; then
  sh "$(dirname "$0")/staple-dmg.sh"
fi
