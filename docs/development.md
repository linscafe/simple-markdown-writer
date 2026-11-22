# Developing mdw

```sh
npm install
npx tauri dev -- -- --no-server "$PWD/samples/kitchen-sink.md"
```

With `tauri dev`, relative paths resolve against `src-tauri/`, so pass an
absolute path.

## Checks

```sh
npm run check
npm run build
cd src-tauri
cargo clippy -- -D warnings
cargo test
cargo build
```

Local image previews can load files from the opened document's directory and its
subdirectories.

## Packaging

```sh
npm run package   # tauri build: release binary + RPM, DEB and AppImage
npm run size      # after npm run build: fails if startup JS exceeds 400 kB gzip
```

Packages land in `src-tauri/target/release/bundle/{rpm,deb,appimage}/`. Install
the RPM with `sudo dnf install ./src-tauri/target/release/bundle/rpm/mdw-*.rpm`
(or the DEB with `sudo apt install ./…deb`), or run the AppImage directly. The
packages install `mdw` and a desktop entry associated with `text/markdown`, so
`.md` files can be opened with mdw from a file manager. The AppImage bundler
downloads `linuxdeploy` on first use.

## Performance

The previous standalone release measured ~420–440 ms to first content on the
kitchen-sink sample on Fedora/WebKitGTK. Compare warm and standalone opens
with a release build and the sample initially closed.

```sh
npx tauri build --no-bundle && install -m755 src-tauri/target/release/mdw ~/.local/bin/mdw
scripts/startup-bench.sh samples/kitchen-sink.md 4  # first run includes startup if the server is stopped
MDW_ARGS=--no-server scripts/startup-bench.sh samples/kitchen-sink.md 3
```

`node samples/gen-large.mjs` writes a 10k-line `samples/large.md` for scrolling
tests; `src/perf.test.ts` times the live-preview passes on it.
