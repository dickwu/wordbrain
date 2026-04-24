#!/usr/bin/env bash
# WordBrain — updater self-upgrade test harness
#
# Purpose:
#   Simulates the 0.0.9 → 0.1.0 auto-upgrade path for Tauri's updater plugin by
#
#     1. Verifying the public key committed in tauri.conf.json matches the
#        private key on disk (.omc/updater/wordbrain.key).
#     2. Signing a dummy payload with the private key, then verifying the
#        signature against the public key. This is exactly the check the
#        updater plugin performs at runtime before applying an update.
#     3. Asserting that a local `latest.json` manifest (built by publish.sh)
#        advertises v0.1.0 > seed version 0.0.9.
#
#   Full end-to-end installation testing requires a built dmg/msi/AppImage
#   running on the target OS; see `docs/release-testing.md` for the manual
#   script that is run on macOS during the Phase 7 release gate.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CONF="src-tauri/tauri.conf.json"
PRIV=".omc/updater/wordbrain.key"
PUB=".omc/updater/wordbrain.key.pub"
SEED_VERSION="${1:-0.0.9}"
TARGET_VERSION="${2:-0.1.0}"

ok()   { printf "\033[1;32m✓\033[0m %s\n" "$*"; }
fail() { printf "\033[1;31m✗\033[0m %s\n" "$*" >&2; exit 1; }

[[ -f "$CONF" ]] || fail "missing $CONF"
[[ -f "$PUB"  ]] || fail "missing $PUB — run scripts/publish.sh --keygen"
[[ -f "$PRIV" ]] || fail "missing $PRIV — run scripts/publish.sh --keygen"

# (1) Pubkey parity
CONF_PUB="$(node -e '
  console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).plugins.updater.pubkey || "")
' "$CONF")"
FILE_PUB="$(cat "$PUB" | tr -d "\n")"
CONF_PUB_NORM="$(echo -n "$CONF_PUB" | tr -d "\n")"
if [[ "$CONF_PUB_NORM" != "$FILE_PUB" ]]; then
  echo "config pubkey: $CONF_PUB_NORM"
  echo "file   pubkey: $FILE_PUB"
  fail "pubkey in $CONF does not match $PUB"
fi
ok "pubkey in $CONF matches $PUB"

# (2) Sign + verify a dummy payload — mirrors the updater plugin's runtime check.
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "wordbrain-updater-self-test $TARGET_VERSION" > "$TMP/payload.bin"
TAURI_SIGNING_PRIVATE_KEY="$(cat "$PRIV")" \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" \
  bunx tauri signer sign "$TMP/payload.bin" >/dev/null
[[ -f "$TMP/payload.bin.sig" ]] || fail "tauri signer did not produce .sig"

# Verify with minisign. Tauri stores both pubkey + .sig base64-wrapped; decode
# before handing them to minisign (which expects the raw minisign format).
if command -v minisign >/dev/null 2>&1; then
  base64 -d < "$PUB"                   > "$TMP/pub.txt"
  base64 -d < "$TMP/payload.bin.sig"   > "$TMP/payload.bin.minisig"
  if minisign -Vm "$TMP/payload.bin" -x "$TMP/payload.bin.minisig" -p "$TMP/pub.txt" >/dev/null; then
    ok "minisign verified signature against WordBrain pubkey"
  else
    fail "minisign verification failed"
  fi
else
  # Fallback: confirm the .sig file was produced.
  [[ -s "$TMP/payload.bin.sig" ]] && ok "signature produced (minisign not installed; skipped deep verify)"
fi

# (3) latest.json sanity (only if publish.sh has run)
MANIFEST="dist-release/latest.json"
if [[ -f "$MANIFEST" ]]; then
  MV="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version)' "$MANIFEST")"
  if [[ "$MV" != "$TARGET_VERSION" ]]; then
    fail "latest.json advertises $MV, expected $TARGET_VERSION"
  fi
  # Semver compare: seed < target
  node -e '
    const [a,b] = process.argv.slice(1);
    const toN = s => s.split(".").map(Number);
    const [A,B] = [toN(a), toN(b)];
    for (let i=0;i<3;i++) { if (A[i]!==B[i]) process.exit(A[i] < B[i] ? 0 : 1); }
    process.exit(1);
  ' "$SEED_VERSION" "$MV" || fail "latest.json version $MV is not greater than seed $SEED_VERSION"
  ok "latest.json advertises $MV (> seed $SEED_VERSION)"
else
  ok "skipped latest.json check (run scripts/publish.sh first to produce one)"
fi

echo
ok "updater self-upgrade pre-flight passed ($SEED_VERSION → $TARGET_VERSION)"
echo "Next: build a v$SEED_VERSION dmg, install it, point endpoints at a local"
echo "      'latest.json' advertising v$TARGET_VERSION, and confirm the app applies"
echo "      the update on launch. See docs/release-testing.md."
