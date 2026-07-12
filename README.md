# Maincode

A simple desktop code editor. Built on Tauri v2 + React + CodeMirror 6,
derived from [cub.dev](https://github.com/ephraimduncan/cub.dev).

## Features

- Open any folder: file tree, tabs, syntax highlighting, find & replace (Cmd+F)
- File operations from the tree (create / rename / delete)
- Command palette (Cmd+K / Cmd+P): quick-open files, commands, theme
- Source control for git repos: stage, unstage, discard, diff view, commit,
  branch switching
- Integrated terminal (Ctrl+`)

## Development

Requires [Bun](https://bun.sh) and the [Rust toolchain](https://rustup.rs).

```bash
bun install
bun run tauri:dev      # hot-reloading dev build
bun run tauri build    # production bundle
bun run test           # frontend unit tests
(cd src-tauri && cargo test)  # backend tests
```

## License

MIT — original work © Ephraim Duncan (cub.dev), modifications © Morpheusdesk.
