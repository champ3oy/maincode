# Releasing maincode

Releases are built and uploaded manually.

## Updater signing key (already set up)

The updater keypair was generated with:
```
npm run tauri signer generate -- --ci -w ~/.tauri/maincode.key
```
- **Private key:** `~/.tauri/maincode.key` — **no password**, kept OUTSIDE the
  repo. **Back it up** (password manager / secure store). If it's lost, future
  updates can't be signed and you'd have to ship a new pubkey (another manual
  install for everyone).
- **Public key:** committed to `plugins.updater.pubkey` in
  `src-tauri/tauri.conf.json`. Do not change it without regenerating the pair.

To rotate (e.g. to add a password), re-run the command above (add `-p <pw>`),
paste the new public key into `tauri.conf.json`, and update the export below.

## Cutting a release

1. Bump the version in `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and `package.json`.
2. Move the `CHANGELOG.md` **Unreleased** entries under the new version heading + date.
3. Build with the updater signing key:
   ```
   export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/maincode.key)"
   export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""   # no password on this key
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
