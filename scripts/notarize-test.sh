#!/bin/sh
# Fast notarization check — submits the ALREADY-BUILT signed Maincode.app to
# Apple's notary service and waits for the verdict (~1 min), so you don't have
# to sit through a full 20-minute `tauri build` just to find out whether the
# Apple Developer agreement is in effect yet.
#
# Requires the same env vars as build-mac.sh:
#   export APPLE_ID="you@example.com"
#   export APPLE_PASSWORD="xxxx-xxxx-xxxx-xxxx"   # app-specific password
#   export APPLE_TEAM_ID="F77F7X4Q2W"
#
#   sh scripts/notarize-test.sh
#
# PASS  -> the agreement is live. Run `sh scripts/build-mac.sh` for the real
#          notarized DMG.
# 403   -> agreement still not in effect (propagation delay, or the wrong
#          agreement / wrong role). See the notes printed on failure.
set -e
cd "$(dirname "$0")/.."

APP="src-tauri/target/release/bundle/macos/Maincode.app"
if [ ! -d "$APP" ]; then
  echo "No built app at $APP — run 'bun run tauri build' (or scripts/build-mac.sh) first." >&2
  exit 1
fi
if [ -z "$APPLE_ID" ] || [ -z "$APPLE_PASSWORD" ] || [ -z "$APPLE_TEAM_ID" ]; then
  echo "Set APPLE_ID / APPLE_PASSWORD / APPLE_TEAM_ID first (see the header of this script)." >&2
  exit 1
fi

ZIP="$(mktemp -d)/Maincode.zip"
echo "→ Zipping the signed app…"
/usr/bin/ditto -c -k --keepParent "$APP" "$ZIP"

echo "→ Submitting to Apple notary service (waits for the verdict)…"
if xcrun notarytool submit "$ZIP" \
  --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_PASSWORD" \
  --wait; then
  echo
  echo "✅ Notarization ACCEPTED — the agreement is live."
  echo "   Now run:  sh scripts/build-mac.sh   (produces the notarized, stapled DMG)"
else
  echo
  echo "❌ Still failing. If it was a 403 'required agreement' error:"
  echo "   • The Account Holder for team $APPLE_TEAM_ID must accept the"
  echo "     Apple Developer Program License Agreement at"
  echo "     https://developer.apple.com/account  → look for a 'Review Agreement' banner."
  echo "     (The App Store Connect 'Paid Applications' agreement does NOT fix notarization.)"
  echo "   • If you just accepted it, give it 15 min–a few hours to propagate, then re-run."
fi
