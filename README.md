# Cub

**A simple git client with AI code review built in.**

<p align="center">
  <img src="docs/screenshot.png" alt="Cub screenshot" />
</p>

---

## What it is

Cub is a desktop git client. You stage, commit, switch branches, and discard changes the way you would in any other client.

The thing it does that other clients don't: you can review your AI-generated changes inline — leave comments on specific lines, classify them as change-requests, questions, or nits — and an MCP server hands those comments back to the agent so it can address them. No copy-pasting line numbers into chat.

## The loop

```
1. Agent writes a bunch of code.
2. You open Cub on the repo (`cub .`).
3. You browse the diff, leave inline comments
   (change-request / question / nit).
4. You hit "Submit review".
5. In your agent: "address the open review in Cub."
   The agent calls the MCP server, gets your comments,
   makes edits, and marks each one resolved or answered.
6. Cub auto-refreshes; you see what changed and what's left.
7. Stage and commit from Cub when you're happy.
```

## Features

**Git client**
- Stage, unstage, and discard files from the sidebar
- Commit with message + optional `--amend`
- Branch switcher in the status bar
- Recent repos and remembered last-opened repo
- Auto-refresh on disk changes

**AI code review**
- Inline comments on single lines or line ranges
- Classify each comment as change-request / question / nit
- Batched submission — all comments go out together as one review
- Live comment lifecycle: pending → acknowledged → resolved / dismissed, updated as the agent works
- MCP server so any MCP-aware agent (Claude Code, Cursor, etc.) can read and respond

**Quality of life**
- System / light / dark theme, persisted
- Diff editor font + size, persisted
- Auto-update

## Agent setup (MCP)

Cub ships a Node sidecar that exposes an MCP server over stdio. Wire it into your agent like any other MCP tool:

```json
{
  "mcpServers": {
    "cub": {
      "command": "cub",
      "args": ["--mcp"]
    }
  }
}
```

Tools exposed:

| Tool | Purpose |
|---|---|
| `watch_reviews` | Long-poll for new submitted reviews |
| `get_review` | Fetch the open review's comments (path, line range, text, action type) |
| `acknowledge_comment` | Mark a comment as in-progress |
| `resolve_comment` | Mark a comment as resolved, with an optional summary |
| `dismiss_comment` | Mark a comment as dismissed, with a reason |
| `resolve_review` | Close out the review when every comment is handled |

> **Note for agents handling `action_type=question`:** answer in the `summary` field of `resolve_comment`. Don't edit code unless the comment is a `change-request`.

## Install

### Homebrew (macOS)

```bash
brew install --cask ephraimduncan/cub/cub
```

The cask picks the right architecture-specific `.dmg` from
[GitHub releases](https://github.com/ephraimduncan/cub.dev/releases)
(`Cub_<version>_aarch64.dmg` on Apple Silicon, `Cub_<version>_x64.dmg`
on Intel), drops `Cub.app` into `/Applications`, and adds a `cub` CLI
symlink in your Homebrew `bin/`. Upgrades land via
`brew upgrade --cask cub`.

The shipped binary is ad-hoc signed (no Developer ID / notarization).
The cask strips the macOS quarantine attribute so first launch isn't
blocked.

### Linux

No Homebrew cask — Cask is macOS-only. Grab a build from
[GitHub releases](https://github.com/ephraimduncan/cub.dev/releases):

- `.deb` for Debian/Ubuntu (`sudo apt install ./Cub_<version>_amd64.deb`)
- `.AppImage` for any distro (`chmod +x Cub_<version>_amd64.AppImage && ./Cub_<version>_amd64.AppImage`)
- `.rpm` for Fedora/RHEL (`sudo dnf install ./Cub-<version>-1.x86_64.rpm`)

Bun is still required for the MCP sidecar — install via
`curl -fsSL https://bun.sh/install | bash` or your package manager.

### From source

Requires [Bun](https://bun.sh), the [Rust toolchain](https://rustup.rs), and
the Tauri v2 [system dependencies](https://v2.tauri.app/start/prerequisites/).

```bash
git clone https://github.com/ephraimduncan/cub.dev
cd cub.dev
bun install
bun run tauri dev          # development build with hot reload
bun run tauri build        # production binary in src-tauri/target/release/bundle
```

### CLI

```bash
cub                # launch with the folder picker
cub .              # launch pointed at the current repo
cub /path/to/repo  # launch pointed at a specific repo
cub --mcp          # MCP-only mode, no GUI (for agent configs)
```

## License

[MIT](LICENSE) © Ephraim Duncan
