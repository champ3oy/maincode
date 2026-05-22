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
3. Bump `version` in `Casks/cub.rb` (SHAs get replaced after CI publishes the artifacts; placeholder zeros are fine here).
4. Commit on a release branch, open a PR, merge to `main`.
5. **Tag and push** from `main`:
   ```bash
   git tag v0.3.0
   git push origin v0.3.0
   ```
6. The `release` workflow fans out across three runners:
   - `macos-14` → `Cub_<v>_aarch64.dmg`
   - `macos-13` → `Cub_<v>_x64.dmg`
   - `ubuntu-22.04` → `Cub_<v>_amd64.deb`, `Cub_<v>_amd64.AppImage`, `Cub-<v>-1.x86_64.rpm`

   Each job uploads to a single **draft** GitHub release and prints the SHA256 of every artifact as a workflow `::notice` (and stages them as `files.txt` in the job's working directory).
7. Open the draft release, sanity-check the artifacts, then **publish**.
8. **Update the cask** in `ephraimduncan/homebrew-cub`:
   ```ruby
   version "0.3.0"
   on_arm do
     sha256 "<aarch64 dmg sha>"
     ...
   end
   on_intel do
     sha256 "<x64 dmg sha>"
     ...
   end
   ```
   Commit & push.

## Triggering a build without a tag

The workflow accepts a `workflow_dispatch` input. Run it from the Actions tab with `tag: v0.3.0-rc1` to produce a draft release without touching `main`.

## Local smoke build

```bash
# Apple Silicon
CI=true bun run tauri build --target aarch64-apple-darwin --bundles dmg,app
# → src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/Cub_<v>_aarch64.dmg

# Intel cross-compile from arm64 host (needs the x86_64 rust target installed)
rustup target add x86_64-apple-darwin
CI=true bun run tauri build --target x86_64-apple-darwin --bundles dmg,app

# Linux (requires the libwebkit2gtk/libgtk/libsoup/etc. dev packages — see
# the workflow's "Install Linux build deps" step)
CI=true bun run tauri build --target x86_64-unknown-linux-gnu --bundles deb,appimage,rpm
```

`CI=true` keeps the Tauri CLI from prompting.

## Notes on signing

The macOS binary is **ad-hoc signed only** — no Apple Developer ID, no notarization. The cask runs `xattr -dr com.apple.quarantine` in `postflight` so first launch isn't blocked by Gatekeeper. If you later get a Developer ID and notarize, drop that `postflight`.

The Tauri updater plugin is still wired in but has a placeholder pubkey, so in-app updates are disabled. Users update via `brew upgrade --cask cub` (macOS) or by reinstalling the latest Linux artifact.
