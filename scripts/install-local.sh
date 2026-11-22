#!/usr/bin/env bash
# Usage: scripts/install-local.sh
# Builds mdw and installs it for the current user without sudo: the mdw
# command, an app-menu entry with icon, and "Open with mdw" for .md files.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
npx tauri build --no-bundle
data=${XDG_DATA_HOME:-$HOME/.local/share}
install -Dm755 src-tauri/target/release/mdw "$HOME/.local/bin/mdw"
install -Dm644 src-tauri/icons/32x32.png "$data/icons/hicolor/32x32/apps/mdw.png"
install -Dm644 src-tauri/icons/128x128.png "$data/icons/hicolor/128x128/apps/mdw.png"
install -Dm644 src-tauri/icons/128x128@2x.png "$data/icons/hicolor/256x256/apps/mdw.png"
mkdir -p "$data/applications"
# Fill the packaging template; an absolute Exec works even if ~/.local/bin is not on the desktop's PATH.
sed -e "s|^Exec={{exec}} %f|Exec=$HOME/.local/bin/mdw %f|" \
    -e 's|{{exec}}|mdw|; s|{{icon}}|mdw|; s|{{name}}|mdw|' \
    -e '/{{#if comment}}/,/{{\/if}}/c\Comment=Live-preview Markdown editor' \
    src-tauri/mdw.desktop > "$data/applications/mdw.desktop"
update-desktop-database "$data/applications" 2>/dev/null || true
gtk-update-icon-cache -q -t "$data/icons/hicolor" 2>/dev/null || true
echo "Installed. mdw is in the app menu, and .md files offer \"Open with mdw\"."
echo "To make it the default for Markdown: xdg-mime default mdw.desktop text/markdown"
