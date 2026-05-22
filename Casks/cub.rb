cask "cub" do
  on_arm do
    version "0.3.0"
    sha256 "6f94efefc4bc34194625e3fd393617dad0d3f7a9dd6a82baabdfbb97d0b4877f"

    url "https://github.com/ephraimduncan/cub.dev/releases/download/v#{version}/Cub_#{version}_aarch64.dmg"
  end
  on_intel do
    # macOS Intel build for v0.3.0 is still queued. Fall back to the
    # known-good universal artifact from v0.2.1 so `brew install` on
    # Intel keeps working; swap to Cub_#{version}_x64.dmg in a follow-up
    # cask PR once the macos-intel job finishes.
    version "0.2.1"
    sha256 "726df73466814a6c96f8698a31efb74c63258318cba69fae3608f5dee896c241"

    url "https://github.com/ephraimduncan/cub.dev/releases/download/v#{version}/Cub_#{version}_universal.dmg"
  end

  name "Cub"
  desc "Simple git client with AI code review built in"
  homepage "https://github.com/ephraimduncan/cub.dev"

  livecheck do
    url "https://github.com/ephraimduncan/cub.dev/releases/latest"
    strategy :github_latest
  end

  # The app is ad-hoc signed (no Developer ID / notarization). Without
  # the postflight below, macOS Gatekeeper blocks first launch from the
  # cask download.
  auto_updates false
  depends_on macos: :big_sur

  app "Cub.app"
  binary "#{appdir}/Cub.app/Contents/MacOS/cub"

  postflight do
    # Strip the quarantine attribute placed by macOS on cask downloads so
    # the ad-hoc signed app can launch without right-click → Open.
    system_command "/usr/bin/xattr",
                   args: ["-dr", "com.apple.quarantine", "#{appdir}/Cub.app"],
                   sudo: false
  end

  zap trash: [
    "~/.cub",
    "~/Library/Application Support/com.ephraimduncan.cub",
    "~/Library/Caches/com.ephraimduncan.cub",
    "~/Library/Preferences/com.ephraimduncan.cub.plist",
    "~/Library/Saved Application State/com.ephraimduncan.cub.savedState",
    "~/Library/WebKit/com.ephraimduncan.cub",
  ]

  caveats <<~EOS
    Cub's MCP sidecar requires Bun. Install one of:

      brew tap oven-sh/bun && brew install bun
      curl -fsSL https://bun.sh/install | bash

    Cub auto-detects Bun at /opt/homebrew/bin/bun, /usr/local/bin/bun,
    ~/.bun/bin/bun, ~/.local/bin/bun, or anywhere on PATH.
  EOS
end
