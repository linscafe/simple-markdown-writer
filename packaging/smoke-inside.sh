# Runs inside a fresh distro container. KIND=rpm|deb|appimage; packages are in /pkgs.
set -uo pipefail
quiet() { "$@" >/tmp/install.log 2>&1 || { tail -20 /tmp/install.log; exit 1; }; }
case $KIND in
  rpm) quiet dnf install -y /pkgs/*.rpm xorg-x11-server-Xvfb desktop-file-utils procps-ng ;;
  deb) export DEBIAN_FRONTEND=noninteractive
       quiet apt-get update
       quiet apt-get install -y --no-install-recommends /pkgs/*.deb xvfb desktop-file-utils procps ;;
  appimage)
       # AppImages leave out libraries every desktop has (fontconfig, harfbuzz, X, GL, ...).
       # The GTK3 runtime stands in for a desktop; WebKit itself must come from the AppImage.
       if command -v dnf >/dev/null; then
            quiet dnf install -y xorg-x11-server-Xvfb procps-ng gtk3
       else export DEBIAN_FRONTEND=noninteractive; quiet apt-get update
            quiet apt-get install -y --no-install-recommends xvfb procps libgtk-3-0 libgbm1 libegl1 libgl1; fi
       ! ldconfig -p | grep -q libwebkit2gtk || { echo "test image unexpectedly has WebKitGTK"; exit 1; }
       export APPIMAGE_EXTRACT_AND_RUN=1
       cp /pkgs/*.AppImage /usr/local/bin/mdw && chmod +x /usr/local/bin/mdw ;;
esac

failed=0
check() {
  local label=$1; shift
  printf '  %-42s' "$label"
  if out=$("$@" 2>&1); then echo ok; else echo FAIL; echo "$out" | tail -8 | sed 's/^/      /'; failed=1; fi
}

check "mdw --help" mdw --help
if [ "$KIND" != appimage ]; then
  desktop=/usr/share/applications/mdw.desktop
  check "libraries resolve" sh -c '! ldd "$(command -v mdw)" | grep "not found"'
  check "desktop entry is valid" desktop-file-validate "$desktop"
  check "desktop entry opens .md files" sh -c "grep -q '^Exec=mdw %f' $desktop && grep -q '^MimeType=.*text/markdown' $desktop"
  check "icon installed" sh -c 'ls /usr/share/icons/hicolor/*/apps/mdw.png'
fi

# A private X server inside the container; WebKit's bubblewrap sandbox cannot nest in an unprivileged container.
export DISPLAY=:99 NO_AT_BRIDGE=1 WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1
export XDG_RUNTIME_DIR=/tmp/runtime HOME=/tmp/home
mkdir -p -m 700 "$XDG_RUNTIME_DIR" "$HOME"
Xvfb :99 -screen 0 1280x1024x24 >/dev/null 2>&1 &
sleep 1
printf '# Hello\n\nSome **bold** text and a table:\n\n| a | b |\n|---|---|\n| 1 | 2 |\n' > /tmp/test.md
frame() { MDW_TIMING=1 MDW_TIMING_QUIT=1 timeout 60 mdw "$@" /tmp/test.md 2>&1 | grep 'first frame'; }
check "standalone window renders" frame --no-server
if [ "$KIND" != appimage ]; then
  check "server starts and opens a window" frame
  check "warm open through the server" frame
  check "server status" sh -c 'mdw --server-status | grep -q "Open windows: 0"'
  check "server stops" sh -c 'mdw --stop-server && sleep 1 && ! pgrep -x mdw'
fi
exit $failed
