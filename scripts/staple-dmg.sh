#!/bin/sh
# Notarize + staple the built Maincode DMG.
#
# Tauri notarizes the .app bundle but ships it inside a merely *signed* .dmg.
# A downloaded, un-notarized DMG triggers macOS's "can't be opened because
# Apple cannot check it for malicious software" prompt on the disk image. This
# notarizes and staples the DMG itself so that prompt never appears.
#
# Requires the same env vars as build-mac.sh:
#   export APPLE_ID="you@example.com"
#   export APPLE_PASSWORD="xxxx-xxxx-xxxx-xxxx"   # app-specific password
#   export APPLE_TEAM_ID="F77F7X4Q2W"
#
#   sh scripts/staple-dmg.sh                 # default DMG path
#   sh scripts/staple-dmg.sh path/to.dmg     # explicit path
set -e
cd "$(dirname "$0")/.."

DMG="${1:-$(ls -t src-tauri/target/release/bundle/dmg/*.dmg 2>/dev/null | head -1)}"
if [ ! -f "$DMG" ]; then
  echo "No DMG at $DMG — build it first (scripts/build-mac.sh)." >&2
  exit 1
fi
if [ -z "$APPLE_ID" ] || [ -z "$APPLE_PASSWORD" ] || [ -z "$APPLE_TEAM_ID" ]; then
  echo "Set APPLE_ID / APPLE_PASSWORD / APPLE_TEAM_ID first (see this script's header)." >&2
  exit 1
fi

echo "→ Notarizing DMG (uploads to Apple, waits for the verdict)…"
xcrun notarytool submit "$DMG" \
  --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_PASSWORD" \
  --wait

echo "→ Stapling the ticket to the DMG…"
xcrun stapler staple "$DMG"

echo "→ Verifying…"
xcrun stapler validate "$DMG"
spctl -a -t open --context context:primary-signature -vv "$DMG" 2>&1 | head -3 || true
echo "✅ DMG notarized + stapled: $DMG"
