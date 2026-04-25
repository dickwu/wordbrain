---
name: wordbrain-release
description: >
  Publish a new release of the WordBrain desktop app and monitor CI on
  github.com/dickwu/wordbrain. Use whenever the user asks to "publish a
  release", "cut a release", "ship v0.x.y", "bump the version", "release
  WordBrain", "check ci" after a tag push, "write release notes", or
  "publish release notes". Also covers verifying the auto-updater endpoint,
  monitoring the Homebrew cask workflow, and recovering from common Tauri
  v2 release-pipeline failures (rustup `universal-apple-darwin`, frozen
  lockfile drift, missing `libpipewire`, signing-key format, Windows
  PowerShell expansion, `--no-default-features` rejected by tauri CLI,
  bash-3.2 globstar on macOS runners, Node 20 action deprecation,
  `release: published` not firing from `GITHUB_TOKEN`-created releases).
  Always prefer this skill over running publish.sh from memory — the
  pipeline has subtle traps documented below.
---

# WordBrain Release Workflow

The project ships via `scripts/publish.sh` plus two GitHub Actions workflows.
A release goes from a clean main to a signed cross-platform GitHub release
plus an auto-updated Homebrew cask in ~10–15 minutes when nothing is broken.

## Project facts (memorise these)

| Fact | Value |
|------|-------|
| Repo | `dickwu/wordbrain` (the `lifefarmer/*` namespace is **only** the macOS bundle id) |
| Bundle id | `com.lifefarmer.wordbrain` (kept for compatibility with the user's other apps) |
| Publish script | `scripts/publish.sh` (NOT `./publish.sh` — it lives under `scripts/`) |
| Release workflow | `.github/workflows/release.yml` — fires on tag `v*` |
| Homebrew workflow | `.github/workflows/homebrew.yml` — fires on `workflow_run` watching `release.yml` (**not** `release: published`, which is blocked by GitHub for `GITHUB_TOKEN`-created releases — see trap #11) |
| Tap repo | `dickwu/homebrew-tap` (shared with the r2 project; cask file is `Casks/wordbrain.rb`) |
| Brew install | `brew install dickwu/tap/wordbrain` |
| Updater endpoint | `https://github.com/dickwu/wordbrain/releases/latest/download/latest.json` (configured in `src-tauri/tauri.conf.json` — verify this any time the GH owner is touched) |
| Updater pubkey | committed at `src-tauri/tauri.conf.json` `plugins.updater.pubkey` |
| Updater private key | `.omc/updater/wordbrain.key` (gitignored, never commit) |

## Required GitHub secrets

| Secret | Purpose | Format |
|--------|---------|--------|
| `TAURI_SIGNING_PRIVATE_KEY` | Signs `latest.json` artifacts so the updater verifies them | **Raw text content of `.omc/updater/wordbrain.key`** — including the leading `untrusted comment: …` line. **NOT** base64-encoded. The publish.sh header used to say "store base64" but that's wrong; Tauri's signer parses the raw minisign format and rejects base64 with `Missing comment in secret key`. |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for the encrypted key (or empty string) | If you generated with `bunx tauri signer generate -w …` and accepted the empty password, set this secret to an empty string explicitly — leaving it unset behaves differently than setting it to `""`. |
| `HOMEBREW_TAP_TOKEN` | PAT used by `homebrew.yml` to push to the tap repo | Fine-grained PAT scoped to `dickwu/homebrew-tap` only, **Contents: Read and write**. |
| `APPLE_*` (optional) | macOS notarization (`APPLE_CERTIFICATE`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`, `APPLE_SIGNING_IDENTITY`, `APPLE_CERTIFICATE_PASSWORD`) | Skips the Gatekeeper warning. Without these the build still succeeds but users see a "downloaded from Internet" prompt. **Do NOT** wire empty `APPLE_*` env vars into `release.yml` — Tauri's signer treats empty strings as "try to use the keychain" and fails with `failed to import keychain certificate`. Either set the secrets to real values or omit the env block entirely (current state). |

### Quick path: bootstrapping `HOMEBREW_TAP_TOKEN`

If the maintainer's `gh auth status` shows admin/push on `dickwu/homebrew-tap`
already (it does for `dickwu`), the fastest setup is to reuse the gh CLI's
own session token:

```bash
gh auth token | gh secret set HOMEBREW_TAP_TOKEN --repo dickwu/wordbrain
```

Caveat: this stores the user's gh CLI session token. If they `gh auth refresh`
or migrate machines the token rotates and the secret needs re-setting. Swap to
a dedicated fine-grained PAT scoped to `dickwu/homebrew-tap` only when hygiene
matters more than speed.

## Pre-flight

`scripts/publish.sh` requires a clean working tree. Always check first:

```bash
git status --short
```

If anything is dirty, commit or stash. Then sanity-check locally:

```bash
bun run test --run                # vitest
( cd src-tauri && cargo check )   # base build
( cd src-tauri && cargo check --features dev-connector )  # dev path
```

Fix anything red before tagging — CI will surface the same issues 10 minutes
later, which wastes a build slot.

## Running the release

`scripts/publish.sh` accepts an **explicit semver** (no `patch`/`minor`/`major`
shortcuts) plus an optional `--ci` flag:

```bash
scripts/publish.sh <x.y.z> --ci   # bump version, commit, tag, push — CI does the build
scripts/publish.sh <x.y.z>        # full local build + signed gh release create
scripts/publish.sh --keygen       # one-time updater keypair generation
```

Default to `--ci` mode. The local mode requires Docker (Linux), `cargo-xwin`
(Windows cross-compile), and the Apple notarization stack — not worth the
local pain unless CI is actively broken.

After `--ci` exits, the tag and the bump commit are already on `origin/main`.
The release run starts immediately.

## Monitoring CI

```bash
gh run list --limit 4 --workflow release.yml
```

Find the new run (`pending` or `in_progress`), then:

```bash
gh run watch <run-id> --exit-status        # blocks; exits non-zero on failure
```

The watch tool is sometimes flaky on its own exit code — always re-confirm
with `gh run list` after the watch returns.

Tauri triple-matrix builds usually run **10–15 minutes**. The macOS leg is
the longest because it builds both arm64 and x64 then `lipo`s them.

When green, two further runs typically appear:
- `homebrew.yml` (release-published trigger) — usually <30 s
- `release.yml`'s `publish` job — collects artifacts and creates the GH release

Verify the release after CI finishes:

```bash
gh release view v<version> --json assets --jq '.assets[].name'
```

You should see (rough names):
- `WordBrain_<version>_universal.dmg`
- `WordBrain_<version>_universal.app.tar.gz` + `.sig`
- `WordBrain_<version>_x64_en-US.msi` + `.msi.zip` + `.msi.zip.sig`
- `wordbrain_<version>_amd64.deb`
- `WordBrain_<version>_amd64.AppImage` + `.AppImage.tar.gz` + `.sig`
- `latest.json`

## Known traps (how to recognise + fix)

These have all bitten this pipeline once. If the symptom matches, jump to
the fix — don't go down the same investigative tree again.

### 1. `error: component 'rust-std' for target 'universal-apple-darwin' is unavailable`

`universal-apple-darwin` is a Tauri-CLI virtual target, not a real rustup
target. The `dtolnay/rust-toolchain@stable` step must install both real
targets on macOS:

```yaml
targets: ${{ matrix.os == 'macos-latest' && 'aarch64-apple-darwin,x86_64-apple-darwin' || matrix.target }}
```

Already wired in `release.yml` (Apr 2026) — don't revert.

### 2. `error: failed to run custom build command for libspa-sys` on Linux

PipeWire dev headers missing. Fix is two-pronged:
- `release.yml` apt-installs `libpipewire-0.3-dev` (belt).
- `tauri-plugin-connector` is now an optional `dev-connector` feature so
  release builds don't compile xcap → libspa at all (suspenders).

If this re-appears, check that `Cargo.toml`'s `[features] default` is `[]`
and that the `Build & bundle` step in `release.yml` doesn't sneak the
feature back in.

### 3. `error: lockfile had changes, but lockfile is frozen`

`bun install --frozen-lockfile` (in CI) refuses to update `bun.lock`.
Caused by `package.json` drifting without re-running `bun install` locally.

Fix:

```bash
bun install        # regenerates bun.lock
git add bun.lock
git commit -m "chore: refresh bun.lock"
```

Then re-cut the release at the next patch version (don't reuse a tagged
version).

### 4. `error: unexpected argument '--no-default-features' found` (tauri build)

Tauri CLI's `build` subcommand only accepts: `--runner`, `--debug`,
`--target`, `--features`, `--bundles`, `--no-bundle`, `--config`, `ARGS`,
`--ci`, `--skip-stapling`, `--ignore-version-mismatches`, `--no-sign`.
It does NOT pass unknown flags through to cargo.

WordBrain's strategy is to make the dev-only feature **opt-in**, not
default-on-then-stripped. So `Cargo.toml` has `default = []`, dev workflow
is `bun run tauri:dev` (which adds `--features dev-connector`), and CI
release just runs `tauri build` with no features.

If you ever need to disable a default feature in CI, you must flip the
default in `Cargo.toml`, NOT pass `--no-default-features`.

### 5. Windows build completes but produces no `.msi`

Windows runners default to PowerShell, where `$VAR` is PowerShell syntax
and does NOT expand env vars. Bash-style `$TAURI_ARGS --bundles $TAURI_BUNDLES`
becomes literal strings, tauri ignores `--bundles`, and only the bare
`wordbrain.exe` gets produced.

Fix: every step that uses bash-style variable expansion must declare
`shell: bash`. Already wired on the `Build & bundle` step in `release.yml`.

### 6. `failed to decode secret key: Missing comment in secret key`

The `TAURI_SIGNING_PRIVATE_KEY` secret is missing the
`untrusted comment: minisign secret key` header line.

Fix:

```bash
cat .omc/updater/wordbrain.key
```

Copy **the entire output** (including the comment line and any blank
lines) and paste as the secret value on `dickwu/wordbrain`. If the
secret was previously stored as base64 (which `publish.sh`'s old comment
incorrectly suggested), re-store it as raw text instead.

### 7. `Permission connector:default not found`

`src-tauri/capabilities/dev-connector.json` is being loaded, but the
`tauri-plugin-connector` plugin isn't compiled (because the
`dev-connector` feature is off).

Fix paths:
- In CI release: `release.yml` has a `Remove dev-only capabilities` step
  that `rm -f`s the file before `tauri build`. Verify it's still there.
- Locally with `cargo check` (no features): expected. Use
  `cargo check --features dev-connector` or temporarily delete the file
  to simulate the CI path.

### 8. Updater endpoint points at the wrong GitHub owner

The `plugins.updater.endpoints[0]` URL in `src-tauri/tauri.conf.json` is
**baked into every shipped binary**. If it points at `lifefarmer/wordbrain`
instead of `dickwu/wordbrain`, those installs will never auto-update.

After any owner-namespace change, grep the repo:

```bash
grep -rn 'lifefarmer/wordbrain\|lifefarmer/homebrew' \
  src-tauri/tauri.conf.json .github/ scripts/ README.md CHANGELOG.md \
  docs/ 2>/dev/null
```

Should be 0 matches. The `com.lifefarmer.*` bundle id is fine — that's
intentional and lives in zap paths, AppData paths, etc.

### 9. `shopt: globstar: invalid shell option name` on macOS only

GitHub's macOS runners ship Apple's bash 3.2 (frozen at GPLv3 in 2007);
`globstar` (the `**` recursive glob) was added in bash 4. Linux + Windows
runners have bash 4+/5+, so the same script passes there silently and only
the macOS leg explodes.

Symptom always lives in **post-build** steps that loop over bundle output
with bash globs. The Tauri build itself does not use globstar — if the
`Build & bundle` step succeeds and the next step blows up, suspect this.

Fix: replace the bash-globstar loop with `find`:

```yaml
- name: Collect bundles
  shell: bash
  run: |
    mkdir -p dist-release
    find src-tauri/target -type f \
      \( -name "*.dmg" -o -name "*.msi" -o -name "*.deb" -o -name "*.AppImage" \
         -o -name "*.app.tar.gz" -o -name "*.app.tar.gz.sig" \
         -o -name "*.msi.zip" -o -name "*.msi.zip.sig" \
         -o -name "*.AppImage.tar.gz" -o -name "*.AppImage.tar.gz.sig" \) \
      -path "*/release/bundle/*" -exec cp -v {} dist-release/ \;
```

Sanity-check any new bash-4-only feature with `/bin/bash --version` (macOS
reports `3.2.57`) before relying on it in CI.

### 10. `Node.js 20 actions are deprecated` warning

`actions/checkout@v4`, `actions/upload-artifact@v4`, and `actions/download-artifact@v4`
still bundle Node 20. GitHub forces Node 24 from **2026-06-02**. Until v5+
majors land, opt in by setting at workflow level:

```yaml
permissions:
  contents: write

env:
  FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: "true"

jobs:
  ...
```

Already wired on both `release.yml` and `homebrew.yml`. Drop the env var
when checkout/upload-artifact ship v5+.

### 11. Homebrew workflow never fires after a release

`gh run list --workflow homebrew.yml` is empty even though the GH release
was published. Root cause: GitHub's anti-recursion safeguard — releases
created by `softprops/action-gh-release@v2` (or anything else using the
default `GITHUB_TOKEN`) do **not** emit `release: published` events for
downstream workflows.

Fix is structural — `homebrew.yml` watches `release.yml` via `workflow_run`,
which is special-cased and fires regardless of upstream token type:

```yaml
on:
  workflow_run:
    workflows: [release]
    types: [completed]
    branches: [main]
  workflow_dispatch:
    inputs:
      tag:
        description: Release tag to publish to Homebrew (for example v0.1.1)
        required: true
        type: string

jobs:
  update-cask:
    if: ${{ github.event_name == 'workflow_dispatch' || github.event.workflow_run.conclusion == 'success' }}
    env:
      DISPATCH_TAG: ${{ inputs.tag }}
      WORKFLOW_RUN_HEAD_BRANCH: ${{ github.event.workflow_run.head_branch }}
```

The tag is read from `github.event.workflow_run.head_branch` because tag
pushes report the tag ref as `head_branch` (e.g. `v0.1.7`). Manual dispatches
supply the tag input directly.

To **backfill** a release that shipped before this fix was in place (or any
time the workflow needs to be re-run with the same tag):

```bash
gh workflow run homebrew.yml --repo dickwu/wordbrain -f tag=v<x.y.z>
```

This is also the right tool for a recovery from trap #4 in the Homebrew
section below (404 on DMG download / wrong filename).

## Reporting status to the user

When the release run finishes successfully, report:

- Version + tag (`v<x.y.z>`)
- Release URL: `https://github.com/dickwu/wordbrain/releases/tag/v<x.y.z>`
- Brew install command: `brew install dickwu/tap/wordbrain` (or
  `brew upgrade wordbrain` for existing installs)
- Direct downloads link: `https://github.com/dickwu/wordbrain/releases/latest`
- Whether the homebrew workflow succeeded — link to its run + the cask commit
  it landed on `dickwu/homebrew-tap`.

If the release run failed, do NOT just say "CI failed" — match the symptom
to one of the eight known traps above and report which fix applies.

## Release notes

The `release.yml` `publish` job populates `body:` with a generic
"WordBrain v… - macOS / Windows / Linux" template. Replace it with curated
notes after CI succeeds.

### Generating notes from git

```bash
git tag --sort=-v:refname | head -2                        # find prev + new tag
git log --oneline <prev-tag>..<new-tag> --no-merges        # commits this release
git diff --stat <prev-tag>..<new-tag> -- ':!bun.lock' \
  ':!src-tauri/Cargo.lock' ':!src-tauri/Cargo.toml' \
  ':!src-tauri/tauri.conf.json' ':!package.json'           # excl. version-bump churn
```

Categorise commits by conventional-commit prefix:

- `feat:` -> "New Features"
- `fix:` -> "Bug Fixes"
- `refactor:` / `perf:` -> "Improvements"
- `chore:` / `ci:` / `docs:` -> "Maintenance"

Skip the version-bump commit (`release: v…`) and any "Co-Authored-By"
boilerplate.

### Template

```markdown
## What's Changed

### New Features
- <one-line description per feat commit>

### Bug Fixes
- <one-line description per fix commit>

### Improvements
- <refactor / perf bullets>

### Maintenance
- <chore / ci / docs bullets — keep short>

## Install

- Homebrew (macOS): `brew install dickwu/tap/wordbrain`
- Direct download: pick the artifact for your platform from the assets below.

**Full Changelog**: https://github.com/dickwu/wordbrain/compare/v<prev>...v<new>
```

Omit empty sections. Keep each bullet on one line.

### Publishing the notes

```bash
gh release edit v<version> --notes "$(cat <<'EOF'
…notes here…
EOF
)"
```

If the release was created as a draft (rare in this pipeline — it shouldn't
be, but check `gh release view`), append `--draft=false`.

## Homebrew cask handoff

The `homebrew.yml` workflow runs automatically once `release.yml` finishes
successfully — via `workflow_run` trigger, NOT `release: published` (see
trap #11 above for why). It downloads the universal DMG, hashes it, and
writes `Casks/wordbrain.rb` to `dickwu/homebrew-tap` via `gh api PUT`.

Common failures:

- **404 on DMG download** — the assumed filename
  `WordBrain_<version>_universal.dmg` doesn't match what was uploaded.
  `gh release view v<version> --json assets --jq '.assets[].name'` gives the
  real names; update `homebrew.yml`'s `DMG_NAME` if Tauri's bundling
  convention has changed.
- **`gh api PUT` 404 / 403** — `HOMEBREW_TAP_TOKEN` lacks write access on
  `dickwu/homebrew-tap`, or the secret is missing entirely. Fix the secret
  and `gh workflow run homebrew.yml -f tag=v<version>` to re-publish without
  cutting a new release.

After it's done:

```bash
brew untap dickwu/tap 2>/dev/null      # purge any old cache
brew tap dickwu/tap
brew search wordbrain                  # should show the cask
```

## Cancelling a botched release

If a tag was pushed but CI failed in a way that bakes a bad endpoint /
bundle id / signing key into a binary, **do not delete the tag** — the
GitHub release artifacts may already be downloaded by users. Instead:

1. Land the fix on `main`.
2. Cut the next patch (`v<x.y.z+1>`).
3. In the next release notes' Maintenance section, note that
   `v<x.y.z>` was withdrawn / does not auto-update.
4. Optionally `gh release edit v<x.y.z> --prerelease` to surface a warning
   on the GH UI.

Updater endpoints are baked into binaries — there is no remote way to fix
an install that shipped with the wrong endpoint short of telling the user
to manually download the next version.
