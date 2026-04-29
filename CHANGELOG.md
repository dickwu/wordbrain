# Changelog

All notable changes to WordBrain are documented in this file. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic
Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] — v0.1.1

Phase 9 — auto-update UI, Homebrew distribution, end-user README.

### Added

- Bottom **status bar** visible on every view (`StatusBar` + `UpdateChecker` under
  `src/app/components/common/`), carrying the current app version, a known-word count, and the
  bundle id.
- **Auto-update flow**: silent check 3 s after launch and every 30 min via
  `@tauri-apps/plugin-updater`, with an "Update available" modal (`Update & Restart` / `Later`)
  backed by `@tauri-apps/plugin-process::relaunch`. Manual checks run via the status-bar button.
- **Settings → General** panel with an "Automatically check for updates" toggle (default on).
  Preference is persisted via the existing `settings` key-value table (IPC keys
  `get_setting`/`set_setting`, wrapper `settingsStore.ts`).
- **Homebrew cask automation** (`.github/workflows/homebrew.yml`) — on every published release,
  downloads the universal macOS DMG, computes SHA-256, and writes `Casks/wordbrain.rb` into the
  tap repo at `dickwu/homebrew-tap` via `gh api PUT`. Users install with
  `brew install dickwu/tap/wordbrain`.
- Vitest coverage for `settingsStore` hydrate/persist round-trip against a mocked Tauri invoke.

### Changed

- `README.md` rewritten as end-user-first (Install / Features / Screenshots / Data storage / Tech
  stack / Development / Releasing / License). The roadmap-style Phase 0–7 checklist moved here to
  `CHANGELOG.md`.
- `scripts/publish.sh` header now documents the Homebrew tap setup and the `HOMEBREW_TAP_TOKEN`
  secret.
- `src/app/page.tsx` hydrates `settingsStore` on boot and wraps `Content` in an inner `Layout` so
  `StatusBar` anchors to the bottom of the content area on every view.

## [0.1.0] — 2026-04-24

Initial public release. Phases 0 through 8 of the WordBrain v1 plan
([`.omc/plans/wordbrain-v1.md`](.omc/plans/wordbrain-v1.md)), produced story-by-story under a ralph
persistence loop.

### Phase 0 — Fork & rename baseline

Forked the Tauri + Next.js skeleton from an internal storage client, stripped the file-transfer
surfaces, and renamed every identifier to WordBrain (bundle id `com.lifefarmer.wordbrain`).

### Phase 1 — Core reading loop

Tiptap v3.22.4 editor with a custom ProseMirror decoration plugin (`WordHighlightExtension`)
highlighting every token against an in-memory `Set<string>` of known lemmas. Stub word card,
hard-coded 500-word seed, tokenizer via `wink-lemmatizer`.

### Phase 1.5 — Frequency seeding + Turso persistence

SUBTLEX-US frequency list bundled; first-launch wizard with cutoff slider; Rust commands
`seed_known_from_frequency` + `get_all_known_lemmas`; in-memory known-set hydrated from SQLite on
startup. Mark-known persists across restarts.

### Phase 2 — Dictionary API lookup

Private Dictionary API settings and lookup UI. The renderer stores only server configuration, while
the API key is encrypted in `tauri-plugin-stronghold` and used by Rust IPC commands. Frontend
`DictionaryFloat` renders API results through the shared dictionary modal.

### Phase 3 — Material library + bipartite edges + i+1 recommender

`materials` and `word_materials` tables; `save_material` / `load_material` /
`record_material_close` / `materials_for_word` Rust commands; library view with search + sort;
graduation of high-exposure words into `known`; undoable auto-exposure.

### Phase 4 — FSRS review queue

`srs_schedule` + `srs_review_log` tables; `add_to_srs`, `list_due_srs`, `count_due_srs`,
`apply_srs_rating` commands; review session UI with rating buttons and due-count sidebar badge.

### Phase 5 — Ingestion expansion

`.md` / `.txt` / `.srt` drag-drop + EPUB parsing split into per-chapter child materials;
`EpubChapterPicker` surface; parent / chapter rows linked via `parent_material_id` +
`chapter_index`.

### Phase 6 — Word network graph + cluster drill-down

cytoscape-fcose layout, click-to-drill clustering, filters by known / learning / unknown, and
a sidebar drawer that opens the source material for any clicked word.

### Phase 7 — Packaging, updater, release

`scripts/publish.sh` + `tauri-plugin-updater` wiring (pubkey + endpoint in `tauri.conf.json`); GH
Actions release matrix (macOS universal, Windows x86_64, Linux x86_64) producing signed DMG / MSI
/ AppImage + `latest.json` updater manifest.

### Phase 8 — Words Manager

Dedicated `Words` view with a virtualised table (`react-virtuoso`); `list_words` (filters +
sort + pagination), `bulk_unmark_known`, `set_word_state`, `set_user_note` backend commands;
in-sidebar clickable known-count badge.
