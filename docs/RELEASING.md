# Releasing maincode

Releases are built and uploaded manually.

0. **One-time, before the first updater-enabled release:** generate the
   updater keypair:
   ```
   npm run tauri signer generate -- -w ~/.tauri/maincode.key
   ```
   Store the private key file and its password securely (password manager).
   Then replace the placeholder `plugins.updater.pubkey` value
   (`"REPLACE_WITH_UPDATER_PUBLIC_KEY_BEFORE_RELEASE"`) in
   `src-tauri/tauri.conf.json` with the public key printed by the command
   above. **Auto-update will not work until this placeholder is replaced.**
1. Bump the version in `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and `package.json`.
2. Move the `CHANGELOG.md` **Unreleased** entries under the new version heading + date.
3. Build with the updater signing key (kept in your password manager):
   ```
   export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/maincode.key)"
   export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="…"
   npm run tauri build
   ```
   This produces the `.dmg`, the `.app.tar.gz`, and its `.sig` (from `createUpdaterArtifacts`).
4. Create the GitHub release `vX.Y.Z`; upload the `.dmg` and the `.app.tar.gz`.
5. Generate the update manifest and upload it as `latest.json` on the same release:
   ```
   node scripts/make-latest-json.mjs 0.1.3 \
     src-tauri/target/release/bundle/macos/maincode.app.tar.gz.sig \
     https://github.com/champ3oy/maincode/releases/download/v0.1.3/maincode.app.tar.gz \
     "See the changelog." > latest.json
   ```
   (Adjust the `.sig` path/asset name to match the actual build output.)

**Version floor:** auto-update only works from a build that already includes the updater (0.1.3+). Users on 0.1.2 install 0.1.3 manually once.
