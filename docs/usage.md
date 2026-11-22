# Using mdw

## Server mode

On Linux, the first `mdw [file.md]` starts a detached server. Later invocations
reuse a hidden window with the editor JavaScript already loaded. The terminal
returns when the document is shown. Opening the same path focuses its window.
With no path, mdw opens the file picker. Closing the last document leaves one
hidden window ready for the next open. Opening through the server takes ~110 ms to
first content, versus ~420 ms for a standalone start.

- `mdw --server-status` shows the PID, open paths, and combined memory of the
  server and its WebKit processes. Run it after closing all documents to measure
  idle cost on your system. RSS includes shared pages in each process. PSS
  apportions those pages and is available when Linux permits reading it.
- `mdw --stop-server` releases that memory. It lists any unsaved documents and
  leaves them open. `mdw --stop-server --force` discards their unsaved edits.
- `mdw --no-server file.md` runs one foreground editor. Set `server = false`
  in `~/.config/mdw/config.toml` to make this the default.
- `mdw --server` runs the server in the foreground, including for a systemd
  user service.

## Usage

### Vim mode
On by default. **Ctrl+Alt+V** toggles it for the current session (`:novim` also
turns it off; use Ctrl+Alt+V to turn it back on). Set `vim = false` in the
config to start without it.

- `:w` save, `:q` quit when clean, `:q!` discard changes, `:wq` / `:x` save and quit.
  Ctrl+S (Cmd+S on macOS) saves in either mode.
- `:e` reload from disk (`:e!` discards changes).
- `gx` / Ctrl+click follows a link; Ctrl+O / Ctrl+I (or Alt+Left / Alt+Right) go back / forward.

### Themes
**Ctrl+Shift+T** opens the theme picker (type to filter, arrows, Enter), or use
`:theme <name>` (`:theme` alone opens the picker). Built-in: `auto` (follows the OS
light/dark setting), `light`, `dark`, `sepia`, plus popular Vim/Neovim schemes:
Tokyo Night, Catppuccin, Gruvbox, Kanagawa, Rosé Pine, Nightfox/Dayfox/Carbonfox,
One Dark/Light, Everforest, Dracula, Nord, Solarized, Sonokai, GitHub, Material,
Monokai, Ayu, Oxocarbon, Nightfly, Moonfly, PaperColor (ids such as
`catppuccin-mocha`, `tokyonight-day`, `rose-pine-dawn`; see `src/themes/`). Drop your own CSS files in
`~/.config/mdw/themes/` to add more. The chosen theme is remembered.

### Images and links
- Paste a screenshot, drag-drop a file, or `:img` / Ctrl+Shift+I to pick one: images
  are copied to `<name>.assets/` and linked. Shift+drop links the original instead.
- Paste a URL over selected text to make a link.
- Typing `](` completes file paths; `#` after a path completes headings.

### Housekeeping
- `:rename <path>` / `:saveas <path>`: rename or copy the document, optionally
  moving or copying its `.assets/` folder and updating links (`!` overwrites).
- `:orphans`: list asset files nothing links to (`d` deletes one; `:orphans!` deletes all).
- `:broken`: list links to missing files or headings (Enter jumps).

## Configuration
Optional `~/.config/mdw/config.toml`. [`config.example.toml`](../config.example.toml)
lists every setting with its default and the alternatives in comments:

```sh
mkdir -p ~/.config/mdw && cp config.example.toml ~/.config/mdw/config.toml
```

Settings: `server`, `theme`, `font_body`, `font_mono`, `font_size`, `line_width`,
`image_dir`, `copy_images`, `vim` (or a `[vim]` table with custom key mappings).
New document windows pick up config and theme file edits. Window size and per-file cursor positions are kept in
`~/.config/mdw/state.json`.
