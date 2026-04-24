# Release testing — WordBrain

End-to-end checks run before every release. Cross-platform bundles are produced
by `.github/workflows/release.yml` when a `v*` tag is pushed; the manual steps
below verify the auto-updater end-to-end on macOS (A10 of the plan).

## 1. Preflight (any machine)

```bash
# Pubkey parity + sign/verify smoke test + latest.json sanity check.
scripts/test-updater.sh
```

Expected: all three checks green. This is also wired as a step in
`.github/workflows/ci.yml` — commit locally before pushing a tag.

## 2. Full build dry-run (macOS)

```bash
# 0.0.9 seed build — this is the artifact we install first.
scripts/publish.sh --keygen               # only if .omc/updater/wordbrain.key is absent
scripts/publish.sh 0.0.9                  # produces dmg + signed .app.tar.gz

# Install the dmg, launch WordBrain once, then quit.
open src-tauri/target/universal-apple-darwin/release/bundle/dmg/WordBrain_0.0.9_universal.dmg
```

## 3. Upgrade target build (macOS)

```bash
# 0.1.0 target — signs + produces latest.json in dist-release/.
scripts/publish.sh 0.1.0
```

Confirm `dist-release/latest.json` advertises `"version": "0.1.0"` with a
non-empty `platforms.darwin-universal.signature`.

## 4. Local updater endpoint

Point the installed v0.0.9 app at a local file server that serves
`latest.json` and the signed bundle:

```bash
cd dist-release
python3 -m http.server 8787 &
# In another shell, override endpoints on the running app:
#   - Edit ~/Library/Application\ Support/com.lifefarmer.wordbrain/settings.json
#     temporarily, OR
#   - Recompile 0.0.9 with "endpoints" set to "http://localhost:8787/latest.json"
open -a WordBrain
```

Expected behaviour:
1. On launch, WordBrain fetches `http://localhost:8787/latest.json`.
2. The updater plugin validates the signature against the pubkey in
   `tauri.conf.json`.
3. Dialog offers "Install and restart"; clicking it applies the patch.
4. Re-launching reports `0.1.0` in the About menu.

If the signature check fails the updater silently ignores the upgrade — check
`~/Library/Logs/com.lifefarmer.wordbrain/*.log` for the validation error.

## 5. Cross-platform matrix

The release workflow runs the same `bun run tauri build` on:

| OS               | bundles            | runner           |
|------------------|--------------------|------------------|
| macOS-latest     | `app,dmg,updater`  | universal-apple  |
| Ubuntu-22.04     | `deb,appimage,updater` | x86_64 linux |
| Windows-latest   | `msi,updater`      | x86_64 MSVC      |

All three must be green before `publish` uploads artifacts + `latest.json` to
the tagged GitHub Release.

## 6. Post-release

```bash
# Bump the Homebrew cask (homebrew/wordbrain.rb) with the new version + sha256:
SHA="$(shasum -a 256 dist-release/WordBrain_0.1.0_universal.dmg | awk '{print $1}')"
gsed -i "s/sha256 :no_check/sha256 \"$SHA\"/" homebrew/wordbrain.rb
```

Push the formula to `lifefarmer/homebrew-tap` so that
`brew install --cask lifefarmer/tap/wordbrain` resolves the new version.
