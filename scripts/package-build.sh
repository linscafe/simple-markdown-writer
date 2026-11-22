#!/usr/bin/env bash
# Usage: scripts/package-build.sh [OUT_DIR]
# Builds the RPM, DEB and AppImage from the committed tree (HEAD) inside an
# Ubuntu 22.04 container, so the packages run on older distributions too.
set -euo pipefail
cd "$(dirname "$0")/.."
out=${1:-packages}
podman build -q -t mdw-builder -f packaging/builder.Containerfile packaging >/dev/null
name=mdw-build-$$
trap 'podman rm -f "$name" >/dev/null 2>&1 || true' EXIT
git archive --format=tar HEAD | podman run -i --name "$name" \
  -v mdw-cargo-registry:/root/.cargo/registry \
  -v mdw-target:/build/src-tauri/target \
  -e APPIMAGE_EXTRACT_AND_RUN=1 -e NO_STRIP=true \
  mdw-builder bash -euc '
    tar -x -C /build
    npm ci --no-audit --no-fund
    npx tauri build
    mkdir /out
    cp src-tauri/target/release/bundle/rpm/*.rpm src-tauri/target/release/bundle/deb/*.deb \
       src-tauri/target/release/bundle/appimage/*.AppImage /out/'
rm -rf "$out"
podman cp "$name:/out" "$out"
ls -lh "$out"
