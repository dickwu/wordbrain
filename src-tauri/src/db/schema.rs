//! Canonical DDL for the WordBrain SQLite schema.
//!
//! Mirrors §4 of `.omc/plans/wordbrain-v1.md`. Run once per connection via
//! `apply(&conn)` — every statement is idempotent (`IF NOT EXISTS`).

use turso::Connection;

use super::{names, DbResult};

/// Creates every table + index listed in §4 of the plan. Idempotent.
pub async fn apply(conn: &Connection) -> DbResult<()> {
    // 4.1 Canonical lemma table
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS words (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          lemma            TEXT    NOT NULL UNIQUE,
          pos              TEXT,
          state            TEXT    NOT NULL DEFAULT 'unknown',
          state_source     TEXT,
          freq_rank        INTEGER,
          exposure_count   INTEGER NOT NULL DEFAULT 0,
          usage_count      INTEGER NOT NULL DEFAULT 0,
          first_seen_at    INTEGER,
          marked_known_at  INTEGER,
          user_note        TEXT,
          created_at       INTEGER NOT NULL,
          updated_at       INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_words_state      ON words(state);
        CREATE INDEX IF NOT EXISTS idx_words_freq_rank  ON words(freq_rank);
        ",
    )
    .await?;

    // 4.1c Proper-name allowlist. These rows are intentionally separate from
    // `words`: names should be ignored by reader highlighting without becoming
    // vocabulary, graph nodes, or SRS candidates.
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS known_names (
          name       TEXT PRIMARY KEY,
          source     TEXT    NOT NULL DEFAULT 'builtin',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_known_names_source ON known_names(source);
        ",
    )
    .await?;
    names::seed_builtin_names_on_conn(conn).await?;

    // 4.1b Learning-loop telemetry. Older DBs predate `usage_count`, so we
    // ALTER it in when missing. The composite index powers the recent-words
    // selection on the Story / Writing surfaces (ORDER BY usage_count ASC,
    // first_seen_at DESC).
    if !column_exists(conn, "words", "usage_count").await? {
        conn.execute(
            "ALTER TABLE words ADD COLUMN usage_count INTEGER NOT NULL DEFAULT 0",
            (),
        )
        .await?;
    }
    conn.execute_batch(
        "
        CREATE INDEX IF NOT EXISTS idx_words_usage_count_first_seen
            ON words(usage_count, first_seen_at);
        ",
    )
    .await?;

    // 4.2 Surface-form → lemma map
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS word_surfaces (
          surface   TEXT PRIMARY KEY,
          lemma_id  INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE
        );
        ",
    )
    .await?;

    // 4.3 Materials
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS materials (
          id                       INTEGER PRIMARY KEY AUTOINCREMENT,
          title                    TEXT    NOT NULL,
          source_kind              TEXT    NOT NULL,
          origin_path              TEXT,
          tiptap_json              TEXT    NOT NULL,
          raw_text                 TEXT    NOT NULL,
          total_tokens             INTEGER NOT NULL,
          unique_tokens            INTEGER NOT NULL,
          unknown_count_at_import  INTEGER NOT NULL,
          parent_material_id       INTEGER REFERENCES materials(id),
          chapter_index            INTEGER,
          mcq_payload              TEXT,
          created_at               INTEGER NOT NULL,
          read_at                  INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_materials_created ON materials(created_at);
        CREATE INDEX IF NOT EXISTS idx_materials_parent  ON materials(parent_material_id);
        ",
    )
    .await?;

    // 4.3b Backfill `mcq_payload` for DBs created before the learning-loop
    // migration. Stories (`source_kind = 'ai_story'`) stash the cloze blanks +
    // MCQ options here; writing submissions leave it NULL. Validation of the
    // expanded `source_kind` enum ('paste' | 'file' | 'url' | 'epub' |
    // 'epub_chapter' | 'ai_story' | 'writing_submission') happens at the IPC
    // boundary because SQLite cannot add a CHECK to an existing column without
    // a full table rebuild.
    if !column_exists(conn, "materials", "mcq_payload").await? {
        conn.execute("ALTER TABLE materials ADD COLUMN mcq_payload TEXT", ())
            .await?;
    }

    // 4.4 Bipartite word ↔ material edge
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS word_materials (
          word_id          INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
          material_id      INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
          occurrence_count INTEGER NOT NULL,
          first_position   INTEGER NOT NULL,
          sentence_preview TEXT,
          PRIMARY KEY (word_id, material_id)
        );
        CREATE INDEX IF NOT EXISTS idx_wm_material ON word_materials(material_id);
        CREATE INDEX IF NOT EXISTS idx_wm_word     ON word_materials(word_id);
        ",
    )
    .await?;

    // 4.5 FSRS schedule + review log
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS srs_schedule (
          word_id          INTEGER PRIMARY KEY REFERENCES words(id) ON DELETE CASCADE,
          stability        REAL    NOT NULL,
          difficulty       REAL    NOT NULL,
          elapsed_days     INTEGER NOT NULL,
          scheduled_days   INTEGER NOT NULL,
          reps             INTEGER NOT NULL DEFAULT 0,
          lapses           INTEGER NOT NULL DEFAULT 0,
          last_review      INTEGER,
          due              INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_srs_due ON srs_schedule(due);

        CREATE TABLE IF NOT EXISTS srs_review_log (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          word_id        INTEGER NOT NULL REFERENCES words(id),
          rating         INTEGER NOT NULL,
          reviewed_at    INTEGER NOT NULL,
          prev_stability REAL,
          new_stability  REAL
        );
        ",
    )
    .await?;

    // 4.6 Bundled offline dictionary
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS dictionary_entries (
          lemma          TEXT NOT NULL,
          pos            TEXT,
          ipa            TEXT,
          definitions_zh TEXT,
          definitions_en TEXT,
          examples       TEXT,
          source         TEXT NOT NULL,
          PRIMARY KEY (lemma, pos, source)
        );
        CREATE INDEX IF NOT EXISTS idx_dict_lemma ON dictionary_entries(lemma);
        ",
    )
    .await?;

    // 4.7 Online + AI lookup cache
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS word_translations_cache (
          lemma          TEXT NOT NULL,
          provider       TEXT NOT NULL,
          context_hash   TEXT NOT NULL DEFAULT '',
          translation_zh TEXT NOT NULL,
          example        TEXT,
          raw_response   TEXT,
          cached_at      INTEGER NOT NULL,
          PRIMARY KEY (lemma, provider, context_hash)
        );
        ",
    )
    .await?;

    // 4.7b User-imported MDict dictionaries. WordBrain stores the MDX index in
    // the local SQLite DB so lookups do not depend on the original folder after
    // import. Small page assets such as CSS are kept beside the MDX blob.
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS custom_dictionaries (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          name        TEXT    NOT NULL,
          source_path TEXT    NOT NULL UNIQUE,
          mdx_path    TEXT    NOT NULL,
          entry_count INTEGER NOT NULL,
          imported_at INTEGER NOT NULL,
          updated_at  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_custom_dict_updated ON custom_dictionaries(updated_at);

        CREATE TABLE IF NOT EXISTS custom_dictionary_files (
          dictionary_id INTEGER NOT NULL REFERENCES custom_dictionaries(id) ON DELETE CASCADE,
          role          TEXT    NOT NULL,
          file_name     TEXT    NOT NULL,
          media_type    TEXT    NOT NULL,
          content       BLOB    NOT NULL,
          byte_size     INTEGER NOT NULL,
          updated_at    INTEGER NOT NULL,
          PRIMARY KEY (dictionary_id, role, file_name)
        );
        CREATE INDEX IF NOT EXISTS idx_custom_dict_files_dictionary
          ON custom_dictionary_files(dictionary_id, role);

        CREATE TABLE IF NOT EXISTS custom_dictionary_resource_archives (
          dictionary_id INTEGER NOT NULL REFERENCES custom_dictionaries(id) ON DELETE CASCADE,
          file_name     TEXT    NOT NULL,
          source_path   TEXT    NOT NULL,
          cache_path    TEXT    NOT NULL,
          byte_size     INTEGER NOT NULL,
          updated_at    INTEGER NOT NULL,
          PRIMARY KEY (dictionary_id, file_name)
        );
        CREATE INDEX IF NOT EXISTS idx_custom_dict_archives_dictionary
          ON custom_dictionary_resource_archives(dictionary_id);

        CREATE TABLE IF NOT EXISTS custom_dictionary_cloud_files (
          dictionary_id INTEGER NOT NULL REFERENCES custom_dictionaries(id) ON DELETE CASCADE,
          file_name     TEXT    NOT NULL,
          media_type    TEXT    NOT NULL,
          public_url    TEXT    NOT NULL,
          byte_size     INTEGER NOT NULL,
          updated_at    INTEGER NOT NULL,
          PRIMARY KEY (dictionary_id, file_name)
        );
        CREATE INDEX IF NOT EXISTS idx_custom_dict_cloud_files_dictionary
          ON custom_dictionary_cloud_files(dictionary_id);
        ",
    )
    .await?;

    // 4.8 Key-value settings
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS settings (
          key        TEXT PRIMARY KEY,
          value      TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        ",
    )
    .await?;

    // 4.9 Per-event log for the learning-loop usage counter. Every
    // `register_word_use` IPC call inserts one row here so the +1 stream
    // is auditable / replayable independent of the cumulative counter on
    // the words row. Surface enum is enforced via CHECK because this table
    // is created fresh, never altered.
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS word_usage_log (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          word_id     INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
          surface     TEXT    NOT NULL CHECK(surface IN ('story_review','writing_train')),
          occurred_at TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_word_usage_log_word_time
            ON word_usage_log(word_id, occurred_at DESC);
        ",
    )
    .await?;

    Ok(())
}

/// `true` when `table.column` already exists. Used by ALTER-style migrations
/// so re-launching against an upgraded DB is a clean no-op.
async fn column_exists(conn: &Connection, table: &str, column: &str) -> DbResult<bool> {
    // pragma_table_info is parametric in Turso; it returns one row per column
    // with `name` in slot 1.
    let sql = format!("PRAGMA table_info({table})");
    let mut rows = conn.query(&sql, ()).await?;
    while let Some(row) = rows.next().await? {
        let name: String = row.get(1)?;
        if name == column {
            return Ok(true);
        }
    }
    Ok(false)
}
