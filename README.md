# mdw — markdown writer

A small, fast desktop editor for a single Markdown file, with Obsidian-style
live preview: formatting renders in place as you type and turns back into plain
Markdown on the line you are editing. There are no vaults, sidebars or
databases. You open one `.md` file, write, and save.

Built with [Tauri 2](https://tauri.app) (Rust) and
[CodeMirror 6](https://codemirror.net), without a UI framework.

## Features

- **Live preview** of headings, emphasis, links, lists, task lists, quotes,
  code blocks with syntax highlighting, tables, math (KaTeX) and images.
- **Vim keybindings**, on by default. Ctrl+Alt+V toggles them, and you can add
  custom mappings.
- **40+ themes**, including Tokyo Night, Catppuccin, Gruvbox, Kanagawa,
  Rosé Pine, Nord, Dracula and Solarized. You can add your own CSS themes.
- **Images**: paste a screenshot or drop a file. It is copied next to the
  document and linked with a relative path.
- **Links**: completion for file paths and headings, and `gx` / Ctrl+click to
  follow a link and Ctrl+O to come back.
- **Housekeeping**: rename a document together with its images, find
  unreferenced images, and list broken links.
- **Fast startup**: an optional background server keeps a window preloaded,
  so files open in about 0.1 s.

## Platform

Linux. It has been tested on Fedora with WebKitGTK. macOS may work but is
untested, and Windows is not supported.

## Install from source

You need [Rust](https://rustup.rs), [Node.js](https://nodejs.org) 20 or newer,
and the [Tauri system dependencies](https://tauri.app/start/prerequisites/#linux).
On Fedora:

```sh
sudo dnf install gcc webkit2gtk4.1-devel openssl-devel librsvg2-devel
```

Then:

```sh
git clone https://github.com/linscafe/simple-markdown-writer.git
cd simple-markdown-writer
npm install
npx tauri build --no-bundle
install -m755 src-tauri/target/release/mdw ~/.local/bin/mdw
```

To build RPM, DEB and AppImage packages with a desktop entry, run
`npm run package` instead.

## Usage

```sh
mdw notes.md          # open a file; a missing file is created on first save
mdw                   # pick a file
mdw --help            # all commands, including the background server
```

| Key | Action |
|---|---|
| `:w` / Ctrl+S | Save |
| `:q`, `:wq` | Quit, or save and quit |
| Ctrl+Shift+T | Theme picker |
| Ctrl+Alt+V | Toggle Vim mode |
| Ctrl+Shift+I | Insert an image |

Settings live in `~/.config/mdw/config.toml`. See
[`config.example.toml`](config.example.toml) for every option with its default.
[`docs/usage.md`](docs/usage.md) covers all commands and features, and
[`docs/development.md`](docs/development.md) covers building, testing and
benchmarks.

## License

[MIT](LICENSE)
