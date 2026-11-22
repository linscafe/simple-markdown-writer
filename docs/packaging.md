# Packaging and release

mdw ships as an RPM (Fedora), a DEB (Debian, Ubuntu) and an AppImage (any
distribution). Each package installs the `mdw` command, an app-menu entry with
an icon, and "Open with mdw" for `.md` files.

Build packages on an old system: a binary built against a newer glibc will not
start on an older one. The scripts and CI build on Ubuntu 22.04 (glibc 2.35),
so the packages run on Debian 12+, Ubuntu 22.04+ and current Fedora.

## Install for yourself, without packages

```sh
scripts/install-local.sh
```

This builds mdw and installs it into `~/.local` without sudo: the binary, the
app-menu entry, the icons, and the `.md` association. To make mdw the default
app for Markdown files, run `xdg-mime default mdw.desktop text/markdown`.

## Build packages locally (podman)

```sh
scripts/package-build.sh          # writes packages/ from the committed tree (HEAD)
scripts/package-smoke.sh          # installs and tests them in fresh containers
```

`package-smoke.sh` installs each package in clean Fedora, Debian 12/13 and
Ubuntu 22.04/24.04 containers. It then checks that:

- `mdw --help` runs and all libraries resolve.
- The desktop entry is valid and opens `.md` files, and the icon is installed.
- A standalone window renders its first frame.
- The server starts, a warm open works, the status reports correctly, and the
  server stops.

Windows open on a private X server inside the container, so nothing appears
on your desktop. WebKit's sandbox is disabled for these tests only, because
bubblewrap cannot nest inside an unprivileged container.

## Release (GitHub Actions)

`.github/workflows/release.yml` builds on Ubuntu 22.04 and runs the checks:

- **Push a tag** such as `v0.1.0` to build the three packages and attach them
  to a **draft** release. Review the draft, then publish it.
  ```sh
  git tag v0.1.0 && git push origin v0.1.0
  ```
- **Run workflow** (Actions tab, or `gh workflow run release.yml`) builds the
  packages as a downloadable artifact, without making a release.

Before tagging, bump the version in `src-tauri/tauri.conf.json`,
`src-tauri/Cargo.toml` and `package.json`.

## Manual desktop test (VM)

Containers cannot check the real desktop integration. Before a release, test
once per distribution in a VM. GNOME Boxes works well: create fresh
**Fedora Workstation** and **Debian 13 (GNOME)** VMs, copy the package in, and
install it:

```sh
sudo dnf install ./mdw-*.x86_64.rpm      # Fedora
sudo apt install ./mdw_*_amd64.deb       # Debian
```

Checklist:

1. mdw appears in Activities when you search "mdw" or "markdown", with its
   icon.
2. Launching it from the menu opens a file picker. Picking a `.md` file opens
   it, and the window shows the mdw icon in the dock rather than a generic
   one.
3. In Files, right-click a `.md` file and choose Open With, then mdw. The file
   opens.
4. Edit, save with `:w`, and close. The file on disk has the change.
5. Open a second file from the menu. It opens quickly, because the server is
   already running.
6. In a terminal, `mdw --server-status` shows the server, and
   `mdw --stop-server` stops it.
7. Log out and back in, then open a file again. The server starts fresh.
8. Uninstall with `sudo dnf remove mdw` or `sudo apt remove mdw`. The menu
   entry disappears.
