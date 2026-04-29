# WordBrain

Local-first English vocabulary builder. Paste, drop, or import reading material and watch every
word colour itself **known / learning / unknown** against your personal vocabulary. Click an unknown
word for a Chinese gloss, mark it as learned, or send it to an FSRS review queue. Every exposure is
logged in a bipartite word ↔ material graph so you can jump from a word to every document that uses
it, get recommended the next doc that hits the Krashen **i+1** sweet spot (≈2–5 % unknown), and watch
your vocabulary densify over time in a cytoscape word-network.

Built with **Tauri v2** + **Next.js 16** + **React 19** + **Tiptap 3** + **Turso SQLite** +
**ts-fsrs**. Everything runs locally — no cloud account, no telemetry, your SQLite file never leaves
the machine unless you export it yourself.

## Install

### Homebrew (macOS)

```bash
brew install dickwu/tap/wordbrain
```

The cask lives in [`dickwu/homebrew-tap`](https://github.com/dickwu/homebrew-tap). It installs the
latest universal `.dmg` into `/Applications/WordBrain.app`, and updates land automatically every
time you run `brew upgrade wordbrain`.

> **First launch on macOS** — the build is not Apple-notarized yet, so Gatekeeper quarantines the
> bundle. After install (or upgrade), clear the quarantine attribute once:
>
> ```bash
> sudo xattr -d com.apple.quarantine /Applications/WordBrain.app/
> ```
>
> Then open WordBrain normally. Notarization will be wired up in a future release.

### Direct download

Pick your platform from the
[Releases page](https://github.com/dickwu/wordbrain/releases/latest):

- **macOS**: `.dmg` (universal — Apple Silicon + Intel)
- **Windows**: `.msi` installer (x86_64)
- **Linux**: `.deb` package or portable `.AppImage` (x86_64)

Every release also ships a signed updater manifest (`latest.json`) so in-app auto-updates work end
to end after the first install.

### Build from source

Requirements: [Bun](https://bun.sh), [Rust](https://rustup.rs) (stable toolchain), macOS 12+ /
Windows 10+ / Ubuntu 22.04+.

```bash
git clone https://github.com/dickwu/wordbrain
cd wordbrain
bun install
bun run tauri dev
```

See [Development](#development) for the full loop.

## Features

- **Known-word highlighting** — a custom Tiptap extension paints every token against an in-memory
  `Set<string>` of known lemmas. Pasting a 10 KB article highlights in well under 500 ms.
- **Private Dictionary API** — word lookup and SRS reveal use your configured dictionary API
  server. The server URL is stored in settings, while the API key is encrypted via
  `tauri-plugin-stronghold` and never leaves Rust.

- **Material library + Krashen i+1 recommender** — every document you import is scored by its
  ratio of unknown lemmas; the library surfaces your next best doc within the 2–5 % sweet spot.
- **FSRS spaced-repetition queue** — mark a word as "review-me" and it enters a `ts-fsrs` schedule
  with due dates, lapse counts, and per-word stability tracking. A due-count badge in the sidebar
  shows how many cards are up today.
- **Word-network graph** — Phase 6 ships a cytoscape-fcose graph clustering your vocabulary by
  shared documents. Click any word to drill down into its neighbours or jump back to source material.
- **EPUB + .srt ingestion** — drop an EPUB and WordBrain splits it into per-chapter child
  materials; drop a subtitle file and each caption line becomes indexable text. Paste / `.md` /
  `.txt` also supported.
- **Words manager** — a dedicated virtualised table lists every known lemma with source, frequency
  rank, exposure count, and user notes. Bulk unmark, set state, or add notes per word.
- **Offline-first SQLite** — a single `wordbrain.db` file holds every lemma, document, exposure
  edge, and FSRS schedule. Bundle id `com.lifefarmer.wordbrain`.
- **Auto-updates** — the status bar shows the current version and silently checks GitHub every
  30 minutes. Toggle this off in Settings → General if you prefer manual checks.

## Screenshots

Capture-in-progress — populate `docs/screenshots/` and reference the files here. The currently
planned set is the reader with highlighting, the word-network graph, and the FSRS review screen.

## Data storage

A single SQLite file per platform (plus the encrypted Stronghold vault for API keys):

- macOS: `~/Library/Application Support/com.lifefarmer.wordbrain/wordbrain.db`
- Windows: `%APPDATA%\com.lifefarmer.wordbrain\wordbrain.db`
- Linux: `~/.local/share/com.lifefarmer.wordbrain/wordbrain.db`

Everything lives in that single file, except encrypted API secrets in the Stronghold vault. Back it
up or `scp` it between machines. WordBrain never phones home beyond the dictionary API server you
configure.

## Tech stack

| Layer         | Choice                                                             |
| ------------- | ------------------------------------------------------------------ |
| Desktop shell | Tauri v2 (Rust)                                                    |
| Frontend      | Next.js 16 (static export), React 19, Ant Design 6, Tailwind CSS 4 |
| Editor        | Tiptap 3 + a custom ProseMirror decoration extension               |
| State         | Zustand (sync) + TanStack React Query (async IPC)                  |
| Database      | Turso SQLite (Rust-native, embedded)                               |
| Tokenizer     | `wink-lemmatizer` (runs in the renderer, no IPC round-trip)        |
| Dictionary    | Private Dictionary API                                             |
| Spaced rep    | `ts-fsrs`                                                          |
| Graph         | cytoscape + `react-cytoscapejs` + `cytoscape-fcose`                |
| Secrets       | `tauri-plugin-stronghold`                                          |
| Auto-update   | `tauri-plugin-updater` (signed `latest.json` from GitHub Releases) |

## Development

```bash
bun install              # install JS deps (Bun only — no npm/yarn)
bun run dev              # Next.js dev server on :3000
bun run tauri dev        # full Tauri desktop session
bun run tauri build      # production build (dmg/msi/AppImage)
bun run format           # prettier write
bun run test             # vitest unit + component tests
```

Rust backend (`cd src-tauri`):

```bash
cargo check              # fast type check
cargo build              # full build
cargo test               # backend unit + integration tests
```

Conventions enforced in [`CLAUDE.md`](CLAUDE.md) / [`AGENTS.md`](AGENTS.md):

- All SQLite writes go through Rust `#[tauri::command]` handlers; the frontend never opens the DB
  directly.
- `App.useApp()` for AntD `message` / `modal` / `notification` — never the module-level static
  exports.
- Components `PascalCase`, stores + hooks `camelCase`.

## Releasing

```bash
scripts/publish.sh 0.1.1 --ci    # bump version, tag, push; GitHub Actions builds + releases
```

The `--ci` path is the normal one — it bumps `package.json`, `src-tauri/tauri.conf.json`, and
`src-tauri/Cargo.toml`, commits, tags, and pushes. GitHub Actions
([`release.yml`](.github/workflows/release.yml)) then builds signed artifacts for all three
platforms, generates `latest.json` for the updater, and creates a GitHub release. A second workflow
([`homebrew.yml`](.github/workflows/homebrew.yml)) downloads the macOS DMG, computes its SHA-256,
and writes an updated cask to the [`dickwu/homebrew-tap`](https://github.com/dickwu/homebrew-tap)
tap repo so `brew upgrade wordbrain` lands the new version.

See [`CHANGELOG.md`](CHANGELOG.md) for version history.

One-time prerequisites (maintainers only):

- `TAURI_SIGNING_PRIVATE_KEY` + `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secrets for updater signing.
- `HOMEBREW_TAP_TOKEN` fine-grained PAT with `Contents: read/write` on the tap repo.
- Optional: Apple notarization secrets (`APPLE_CERTIFICATE`, `APPLE_ID`, `APPLE_TEAM_ID`,
  `APPLE_PASSWORD`) to drop the Gatekeeper warning on macOS.

## License

MIT © Peilin Wu
