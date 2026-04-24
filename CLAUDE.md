# CLAUDE.md

Guidance for Claude Code working in this repo.

## Project

**WordBrain** — local-first English vocabulary builder. Tauri v2 + Next.js 16 + React 19 + Tiptap 3
+ Turso SQLite. English tokenization with Chinese glosses. Single-user, cross-platform desktop app.

Canonical plan: `.omc/plans/wordbrain-v1.md`. Acceptance criteria: `.omc/prd.json`.

## Commands

```bash
bun install              # Install JS dependencies (Bun, not npm)
bun run dev              # Next.js dev server on :3000
bun run tauri dev        # Full Tauri app in dev mode
bun run tauri build      # Production build (dmg/msi/AppImage)
bun run format           # Prettier write
bun run format:check     # Prettier check
```

Rust backend from `src-tauri/`:

```bash
cargo build              # Build Rust backend
cargo check              # Type-check
cargo test               # Backend tests
```

## Architecture

- **Frontend** (`src/app/`): Next.js 16 static export (`output: 'export'`), React 19, Ant Design 6,
  Tailwind 4. State via Zustand stores in `src/app/stores/`. Async state via TanStack React Query.
- **Backend** (`src-tauri/src/`): Tauri v2, Rust. SQLite via Turso (`turso` crate). Commands grouped
  by domain in `src-tauri/src/commands/`. Schema and DB helpers in `src-tauri/src/db/`.
- **Editor surface**: Tiptap v3 with a custom ProseMirror decoration plugin (`WordHighlightExtension`)
  that colours tokens against the in-memory known-word Set.
- **Dictionary stack**: three tiers, all behind Rust IPC —
  1. Bundled ECDICT (offline, primary)
  2. Youdao / DeepL (online, cached in `word_translations_cache`)
  3. AI on-demand gloss (Ollama / OpenAI / Anthropic)
  API keys encrypted at rest via `tauri-plugin-stronghold`; never sent to renderer.

## Conventions

- **Package manager**: Bun. No npm/yarn.
- **AntD message API**: always `const { message } = App.useApp()`. Never `import { message } from 'antd'`.
- **Tauri IPC**: backend exposes `#[tauri::command]`; frontend calls via `@tauri-apps/api/invoke`.
- **Naming**: PascalCase for React components, camelCase for stores/hooks/utils.
- **SQLite writes**: go through Rust commands only. Frontend never opens the DB directly.
- **Known-word set** is kept in `src/app/stores/wordStore.ts` as an in-memory `Set<string>` for
  O(1) highlight lookup; mutations round-trip through IPC for persistence.

## Don't

- Don't reintroduce S3 / R2 / AWS / MinIO / RustFS / file-upload UI — the repo was forked from an
  S3 client and stripped deliberately.
- Don't mock the SQLite layer in integration tests — hit a real in-memory Turso DB.
- Don't hardcode API keys anywhere; use Settings > ApiKeysPanel + Stronghold.
