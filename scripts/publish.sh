#!/usr/bin/env bash
# WordBrain — publish.sh
# Tag a release, build signed artifacts for macOS/Windows/Linux, and push to GitHub.
#
# Usage:
#   scripts/publish.sh <version>              # full release (tag + local build + gh release)
#   scripts/publish.sh <version> --ci         # tag + push only (GitHub Actions does the build)
#   scripts/publish.sh --keygen               # generate a new updater keypair
#   scripts/publish.sh --help
#
# Examples:
#   scripts/publish.sh 0.1.0
#   scripts/publish.sh 0.1.0 --ci
#
# Prerequisites:
#   * Bun (https://bun.sh) + Rust toolchain (rustup)
#   * GitHub CLI (`gh auth status` must be green)
#   * For macOS notarization (optional): APPLE_CERTIFICATE, APPLE_CERTIFICATE_PASSWORD,
#     APPLE_SIGNING_IDENTITY, APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID env vars
#   * TAURI_SIGNING_PRIVATE_KEY (+ optional TAURI_SIGNING_PRIVATE_KEY_PASSWORD) for updater signing
#   * Cross-builds from macOS → Windows use cargo-xwin (`cargo install cargo-xwin`)
#
# ─────────────────────────────────────────────────────────────────────────────
# Updater keypair (one-time, then keep the private key SECRET):
#
#   bunx tauri signer generate -w .omc/updater/wordbrain.key
#   # produces wordbrain.key (PRIVATE, keep offline) + wordbrain.key.pub (public)
#
# Copy the contents of wordbrain.key.pub into `plugins.updater.pubkey` in
# src-tauri/tauri.conf.json (already done for 0.1.0).
#
# For CI signing, export the PRIVATE key:
#   export TAURI_SIGNING_PRIVATE_KEY="$(cat .omc/updater/wordbrain.key)"
#   export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""   # or the password you chose
#
# In GitHub Actions, store the base64 of the private key file as the
# TAURI_SIGNING_PRIVATE_KEY secret; the release workflow wires it through.
# NEVER commit wordbrain.key — it is already covered by the top-level .gitignore.
#
# ─────────────────────────────────────────────────────────────────────────────
# Homebrew distribution (.github/workflows/homebrew.yml):
#
# On every published GitHub release, the homebrew workflow downloads the macOS
# universal DMG, computes its sha256, and writes `Casks/wordbrain.rb` into the
# shared tap repo at dickwu/homebrew-tap (same tap r2 uses). Users install with:
#
#   brew install dickwu/tap/wordbrain
#
# Prerequisites (one-time): the tap repo dickwu/homebrew-tap already exists
# from the r2 project. Create a fine-grained PAT scoped to that tap repo,
# Contents: Read and write, and save as the `HOMEBREW_TAP_TOKEN` secret on
# dickwu/wordbrain.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

log() { printf "\033[1;36m[publish]\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[publish]\033[0m %s\n" "$*" >&2; }
die() { printf "\033[1;31m[publish]\033[0m %s\n" "$*" >&2; exit 1; }

usage() {
  sed -n '1,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
}

keygen() {
  mkdir -p .omc/updater
  if [[ -f .omc/updater/wordbrain.key ]]; then
    die "Key already exists at .omc/updater/wordbrain.key — refusing to overwrite."
  fi
  bunx tauri signer generate -w .omc/updater/wordbrain.key
  log "Public key (paste into src-tauri/tauri.conf.json plugins.updater.pubkey):"
  cat .omc/updater/wordbrain.key.pub
}

bump_version() {
  local v="$1"
  log "Bumping version → $v"
  # package.json
  node -e '
    const fs = require("fs");
    const p = JSON.parse(fs.readFileSync("package.json", "utf8"));
    p.version = process.argv[1];
    fs.writeFileSync("package.json", JSON.stringify(p, null, 2) + "\n");
  ' "$v"
  # tauri.conf.json
  node -e '
    const fs = require("fs");
    const p = JSON.parse(fs.readFileSync("src-tauri/tauri.conf.json", "utf8"));
    p.version = process.argv[1];
    fs.writeFileSync("src-tauri/tauri.conf.json", JSON.stringify(p, null, 2) + "\n");
  ' "$v"
  # Cargo.toml — rewrite the first `version = "x.y.z"` line (the package one).
  python3 - "$v" <<'PY'
import sys, pathlib, re
v = sys.argv[1]
p = pathlib.Path("src-tauri/Cargo.toml")
text = p.read_text()
new, n = re.subn(r'^version = "[^"]*"', f'version = "{v}"', text, count=1, flags=re.M)
if n != 1:
    raise SystemExit("could not find a version line in src-tauri/Cargo.toml")
p.write_text(new)
PY
}

verify_signing_env() {
  if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
    if [[ -f .omc/updater/wordbrain.key ]]; then
      warn "TAURI_SIGNING_PRIVATE_KEY not set — loading from .omc/updater/wordbrain.key"
      export TAURI_SIGNING_PRIVATE_KEY="$(cat .omc/updater/wordbrain.key)"
      export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"
    else
      die "TAURI_SIGNING_PRIVATE_KEY is unset and .omc/updater/wordbrain.key is missing. Run \`scripts/publish.sh --keygen\` or supply the env var."
    fi
  fi
}

build_macos() {
  log "Building macOS (dmg + updater tarball)"
  bun run tauri build --target universal-apple-darwin
}

build_windows_xwin() {
  log "Building Windows (msi via cargo-xwin)"
  if ! command -v cargo-xwin >/dev/null 2>&1; then
    warn "cargo-xwin not installed; skipping Windows build. Install via: cargo install cargo-xwin"
    return 1
  fi
  bun run tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles msi,updater
}

build_linux_docker() {
  log "Building Linux (deb + AppImage) in docker"
  if ! command -v docker >/dev/null 2>&1; then
    warn "docker not available; skipping Linux cross-build. Run this in CI or a Linux host."
    return 1
  fi
  docker run --rm -v "$ROOT":/src -w /src \
    -e TAURI_SIGNING_PRIVATE_KEY \
    -e TAURI_SIGNING_PRIVATE_KEY_PASSWORD \
    ghcr.io/tauri-apps/tauri-build:latest \
    bash -lc 'bun install && bun run tauri build --bundles deb,appimage,updater'
}

collect_artifacts() {
  local version="$1"
  local out="$ROOT/dist-release"
  rm -rf "$out" && mkdir -p "$out"
  log "Collecting artifacts → $out"
  shopt -s globstar nullglob
  for f in \
    src-tauri/target/universal-apple-darwin/release/bundle/dmg/*.dmg \
    src-tauri/target/universal-apple-darwin/release/bundle/macos/*.app.tar.gz* \
    src-tauri/target/x86_64-pc-windows-msvc/release/bundle/msi/*.msi \
    src-tauri/target/x86_64-pc-windows-msvc/release/bundle/msi/*.msi.zip* \
    src-tauri/target/release/bundle/deb/*.deb \
    src-tauri/target/release/bundle/appimage/*.AppImage \
    src-tauri/target/release/bundle/appimage/*.AppImage.tar.gz*; do
    cp -v "$f" "$out/" 2>/dev/null || true
  done
  log "Artifacts ready:"
  ls -la "$out"
}

build_latest_json() {
  # Writes dist-release/latest.json consumable by tauri-plugin-updater.
  local version="$1"
  local notes="$2"
  local out="$ROOT/dist-release/latest.json"
  log "Writing updater manifest → $out"

  python3 - "$version" "$notes" "$ROOT/dist-release" <<'PY'
import json, os, sys, pathlib, datetime
version, notes, dist = sys.argv[1], sys.argv[2], pathlib.Path(sys.argv[3])

platforms = {}

def add(platform_key, installer_glob, sig_glob):
    for sig in dist.glob(sig_glob):
        base = sig.name[:-4]  # strip .sig
        url = f"https://github.com/dickwu/wordbrain/releases/download/v{version}/{base}"
        sig_content = sig.read_text().strip()
        platforms[platform_key] = {"signature": sig_content, "url": url}

add("darwin-universal", "*.app.tar.gz", "*.app.tar.gz.sig")
add("windows-x86_64",  "*.msi.zip",    "*.msi.zip.sig")
add("linux-x86_64",    "*.AppImage.tar.gz", "*.AppImage.tar.gz.sig")

manifest = {
    "version": version,
    "notes":   notes or f"WordBrain {version}",
    "pub_date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "platforms": platforms,
}

(dist / "latest.json").write_text(json.dumps(manifest, indent=2) + "\n")
PY
}

gh_release() {
  local version="$1"
  local tag="v${version}"
  log "Creating GitHub release $tag"
  gh release view "$tag" >/dev/null 2>&1 && die "Release $tag already exists."
  gh release create "$tag" \
    --title "WordBrain $version" \
    --notes  "WordBrain $version — see CHANGELOG.md" \
    dist-release/*
}

main() {
  case "${1:-}" in
    ""|--help|-h) usage ;;
    --keygen)     keygen; exit 0 ;;
  esac

  local version="$1"
  local mode="${2:-full}"

  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "Version must be semver x.y.z (got '$version')"

  if [[ -n "$(git status --porcelain)" ]]; then
    die "Working tree is dirty — commit or stash before publishing."
  fi

  bump_version "$version"
  git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock 2>/dev/null || true
  git commit -m "release: v${version}" || warn "Nothing to commit."
  git tag -a "v${version}" -m "WordBrain v${version}"

  if [[ "$mode" == "--ci" ]]; then
    log "CI mode — pushing tag; GitHub Actions will build and release."
    git push origin HEAD
    git push origin "v${version}"
    log "Done. Watch: gh run watch"
    exit 0
  fi

  verify_signing_env
  build_macos
  build_windows_xwin || warn "Windows build skipped."
  build_linux_docker || warn "Linux build skipped."
  collect_artifacts "$version"
  build_latest_json "$version" "WordBrain $version"
  gh_release "$version"
  git push origin HEAD
  git push origin "v${version}"
  log "Release v${version} published."
}

main "$@"
