cask "cub" do
  version "0.2.0"
  sha256 "5167e76a439f2072afb4c41df50f7f34ae32584125e976fd560955b33640504b"

  url "https://github.com/ephraimduncan/cub.dev/releases/download/v#{version}/Cub_#{version}_universal.dmg"
  name "Cub"
  desc "Simple git client with AI code review built in"
  homepage "https://github.com/ephraimduncan/cub.dev"

  livecheck do
    url :url
    strategy :github_latest
  end

  # The app is ad-hoc signed (no Developer ID / notarization). Without this,
  # macOS Gatekeeper blocks first launch from the cask download.
  auto_updates false
  depends_on macos: :big_sur
  depends_on formula: "bun"

  app "Cub.app"
  binary "#{appdir}/Cub.app/Contents/MacOS/cub"

  postflight do
    # Strip the quarantine attribute placed by macOS on cask downloads so the
    # ad-hoc signed app can launch without right-click → Open. Re-applying it
    # after copy mirrors what `--no-quarantine` does, scoped to this cask.
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
end
