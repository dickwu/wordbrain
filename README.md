# WordBrain

Local-first English vocabulary builder. Paste, drop, or import reading material and watch the editor
colour every word as **known / learning / unknown** against your personal known-word list. Click
an unknown word to see its Chinese meaning, mark it as learned, or add it to an FSRS spaced-repetition
review queue. Every exposure is logged into a bipartite word ↔ material table so you can (a) jump
from any word to all the other documents where it appears, (b) get recommended the next doc that
hits the Krashen i+1 sweet spot (≈2–5% unknown), and (c) watch your vocabulary densify in a
cytoscape word-network graph.

Built with **Tauri v2**, **Next.js 16**, **React 19**, **Tiptap 3**, **Turso SQLite**, and **ts-fsrs**.

## Status

This is an early-stage project. See [`.omc/plans/wordbrain-v1.md`](.omc/plans/wordbrain-v1.md) for
the full phased implementation plan and [`.omc/prd.json`](.omc/prd.json) for acceptance criteria.

- [x] Phase 0 — Fork & rename baseline
- [ ] Phase 1 — Tiptap highlight loop
- [ ] Phase 1.5 — Frequency seeding (SUBTLEX-US) + Turso persistence
- [ ] Phase 2 — Dictionary stack (offline ECDICT → online Youdao/DeepL → AI on-demand gloss)
- [ ] Phase 3 — Material library + bipartite edges + next-doc recommender
- [ ] Phase 4 — FSRS review queue
- [ ] Phase 5 — EPUB + .srt ingestion
- [ ] Phase 6 — Cytoscape word-network graph + cluster drill-down
- [ ] Phase 7 — Cross-platform packaging + release

## Development

```bash
# Prerequisites: Node.js ≥ 18, Bun, Rust toolchain (rustup)
bun install
bun run tauri dev
```

Build for release:

```bash
bun run tauri build
```

## Data storage

- macOS: `~/Library/Application Support/com.lifefarmer.wordbrain/wordbrain.db`
- Windows: `%APPDATA%\com.lifefarmer.wordbrain\wordbrain.db`
- Linux: `~/.local/share/com.lifefarmer.wordbrain/wordbrain.db`

Everything lives in a single SQLite file — fully offline, fully yours.

## License

MIT © Peilin Wu
