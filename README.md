# Maincode

A simple lightweight code editor without the bloatware.

Built on Tauri v2 + React + CodeMirror 6,
derived from [cub.dev](https://github.com/ephraimduncan/cub.dev).

Download [Latest Release](https://code.cirlorm.dev)

![Maincode](docs/screenshot.gif)

## Features

- Open any folder: file tree, tabs, syntax highlighting, find & replace (Cmd+F)
- File operations from the tree (create / rename / delete)
- Integrated terminal (Ctrl+`)
- Source control for git repos: stage, unstage, discard, diff view, commit,
  branch switching

## CLI

Open a folder in the editor straight from your terminal with the `main`
command. Install it once (pick any directory on your `PATH`):

```bash
cp scripts/main ~/bin/main && chmod +x ~/bin/main   # make sure ~/bin is on your PATH
```

Then:

```bash
main              # open the current directory
main .            # open the current directory
main path/to/dir  # open a specific folder
```

Requires `Maincode.app` in `/Applications` (or `~/Applications`).

## License

MIT — original work © Ephraim Duncan (cub.dev), modifications © Selorm Akoto (maincode).
