# Releasing Cub

End-to-end recipe for cutting a new release that lands in Homebrew.

## Prerequisites (one-time)

1. **Create a tap repo** on GitHub: `ephraimduncan/homebrew-cub`.
   - Public, empty repo. No README required.
   - Add a top-level `Casks/` directory.
2. **Seed it** with the cask file from this repo:
   ```bash
   git clone git@github.com:ephraimduncan/homebrew-cub.git
   cp Casks/cub.rb ../homebrew-cub/Casks/cub.rb
   cd ../homebrew-cub && git add Casks/cub.rb && git commit -m "add cub cask" && git push
   ```

Once that exists, anyone can install Cub with:

```bash
brew install --cask ephraimduncan/cub/cub
```

## Cutting a release

1. **Bump the version** in three files (must match):
   - `package.json` → `"version"`
   - `src-tauri/Cargo.toml` → `version`
   - `src-tauri/tauri.conf.json` → `"version"`
2. Refresh `src-tauri/Cargo.lock`:
   ```bash
   (cd src-tauri && cargo update -p cub)
   ```
3. Commit on a release branch, open a PR, merge to `main`.
4. **Tag and push** from `main`:
   ```bash
   git tag v0.2.0
   git push origin v0.2.0
   ```
5. The `release` workflow (.github/workflows/release.yml) runs on `macos-14`,
   builds a universal `.app` + `.dmg`, and uploads `Cub_<version>_universal.dmg`
   to a **draft** GitHub release. SHA256 is printed in the release notes and as
   a workflow `::notice`.
6. Open the draft release, sanity-check the DMG, then **publish**.
7. **Update the cask** in `ephraimduncan/homebrew-cub`:
   ```ruby
   version "0.2.0"
   sha256 "<paste from release notes>"
   ```
   Commit & push.

## Triggering a build without a tag

The workflow accepts a `workflow_dispatch` input. Run it from the Actions tab
with `tag: v0.2.0-rc1` to produce a draft release without touching `main`.

## Local smoke build

```bash
CI=true bun run tauri build --target aarch64-apple-darwin --bundles dmg,app
# → src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/Cub_<version>_aarch64.dmg
```

`CI=true` keeps the Tauri CLI from prompting; the `--bundles dmg,app` flag
skips updater bundles (which would require a signing private key).

## Notes on signing

The shipped binary is **ad-hoc signed only** — no Apple Developer ID, no
notarization. The cask runs `xattr -dr com.apple.quarantine` in `postflight`
so first launch isn't blocked by Gatekeeper. If you later get a Developer ID
and notarize, drop that `postflight` and add the standard `app` stanza.

The Tauri updater plugin is still wired in but has a placeholder pubkey,
so in-app updates are disabled. Users update via `brew upgrade --cask cub`.
