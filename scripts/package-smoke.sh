#!/usr/bin/env bash
# Usage: scripts/package-smoke.sh [PACKAGE_DIR] [FILTER]   (FILTER: e.g. appimage, debian)
# Installs the packages from scripts/package-build.sh in fresh Fedora, Debian
# and Ubuntu containers, checks the install, and opens a window on a private
# X server inside each container (nothing appears on your desktop).
set -uo pipefail
cd "$(dirname "$0")/.."
dir=$(realpath "${1:-packages}")
filter=${2:-}
matrix=(
  "rpm fedora:latest"
  "deb debian:12"
  "deb debian:13"
  "deb ubuntu:22.04"
  "deb ubuntu:24.04"
  "appimage debian:12"
  "appimage fedora:latest"
)
status=0
for entry in "${matrix[@]}"; do
  read -r kind image <<< "$entry"
  [[ -z $filter || $entry == *"$filter"* ]] || continue
  echo "== $kind on $image"
  podman run --rm -i -e KIND="$kind" -v "$dir:/pkgs:ro,z" "docker.io/library/$image" bash -s \
    < packaging/smoke-inside.sh || status=1
done
[ $status = 0 ] && echo "All package checks passed" || echo "Some package checks failed"
exit $status
