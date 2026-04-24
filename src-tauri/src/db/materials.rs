//! Query helpers for `materials` + `word_materials` (§4.3–§4.4 of the plan).
//!
//! Mirrors the split-surface pattern used by [`super::words`]: every helper is
//! available in an `*_on_conn(&Connection, …)` flavour so integration tests can
//! exercise the real SQL against a temp-dir DB, plus a thin wrapper that grabs
//! the global singleton for use by Tauri commands at runtime.

use serde::{Deserialize, Serialize};
use turso::Connection;

use super::{get_connection, now_ms, DbResult};

// ---------------------------------------------------------------------------
// Input / output shapes. Mirrored in `src/app/lib/ipc.ts`.
// ---------------------------------------------------------------------------

/// One pre-tokenised `(lemma, material)` edge. The frontend does tokenisation
/// + lemmatisation (wink-lemmatizer) then sends a flattened list in a single
/// IPC so the Rust side never owns English NLP state.
#[derive(Debug, Clone, Deserialize)]
pub struct TokenEdge {
    pub lemma: String,
    pub occurrence_count: i64,
    pub first_position: i64,
    pub sentence_preview: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SaveMaterialInput {
    pub title: String,
    pub source_kind: String,
    pub origin_path: Option<String>,
    pub tiptap_json: String,
    pub raw_text: String,
    pub total_tokens: i64,
    pub unique_tokens: i64,
    pub tokens: Vec<TokenEdge>,
    /// Phase-5: when this material is a child (EPUB chapter), points at the
    /// book-level material. `None` for standalone paste/file imports.
    #[serde(default)]
    pub parent_material_id: Option<i64>,
    /// Phase-5: 0-based index within the parent's spine. `None` for non-EPUB.
    #[serde(default)]
    pub chapter_index: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SaveMaterialOutput {
    pub material_id: i64,
    pub unknown_count_at_import: i64,
    pub total_tokens: i64,
    pub unique_tokens: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct MaterialSummary {
    pub id: i64,
    pub title: String,
    pub source_kind: String,
    pub total_tokens: i64,
    pub unique_tokens: i64,
    pub unknown_count: i64,
    pub unknown_count_at_import: i64,
    pub created_at: i64,
    pub read_at: Option<i64>,
    pub parent_material_id: Option<i64>,
    pub chapter_index: Option<i64>,
}

/// Full payload returned by `load_material`, including raw body + tiptap JSON
/// so the reader can re-render a previously saved document.
#[derive(Debug, Clone, Serialize)]
pub struct MaterialFull {
    pub id: i64,
    pub title: String,
    pub source_kind: String,
    pub origin_path: Option<String>,
    pub raw_text: String,
    pub tiptap_json: String,
    pub total_tokens: i64,
    pub unique_tokens: i64,
    pub created_at: i64,
    pub read_at: Option<i64>,
    pub parent_material_id: Option<i64>,
    pub chapter_index: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MaterialForWord {
    pub material_id: i64,
    pub title: String,
    pub created_at: i64,
    pub read_at: Option<i64>,
    pub occurrence_count: i64,
    pub first_position: i64,
    pub sentence_preview: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RecommendedMaterial {
    pub id: i64,
    pub title: String,
    pub total_tokens: i64,
    pub unique_tokens: i64,
    pub unknown_count: i64,
    pub unknown_ratio: f64,
    pub score: f64,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct MaterialCloseOutcome {
    pub graduated_to_learning: Vec<String>,
    pub graduated_to_known: Vec<String>,
    pub exposure_threshold: i64,
}

// ---------------------------------------------------------------------------
// save_material
// ---------------------------------------------------------------------------

/// Persist a new material and every `(word, material)` edge.
///
/// Every lemma in `input.tokens` is upserted into `words` with
/// `state='unknown'` + `state_source='import'` if it does not already exist, so
/// the bipartite edge always points at a real row. Existing lemmas are left
/// untouched (we don't want to overwrite a seeded `state='known'` row).
pub async fn save_material_on_conn(
    conn: &Connection,
    input: &SaveMaterialInput,
) -> DbResult<SaveMaterialOutput> {
    let now = now_ms();

    conn.execute("BEGIN IMMEDIATE;", ()).await?;
    let tx_result: DbResult<SaveMaterialOutput> = async {
        // 1. Insert the material row.
        conn.execute(
            "INSERT INTO materials \
               (title, source_kind, origin_path, tiptap_json, raw_text, \
                total_tokens, unique_tokens, unknown_count_at_import, \
                parent_material_id, chapter_index, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?9, ?10)",
            turso::params![
                input.title.as_str(),
                input.source_kind.as_str(),
                input.origin_path.as_deref(),
                input.tiptap_json.as_str(),
                input.raw_text.as_str(),
                input.total_tokens,
                input.unique_tokens,
                input.parent_material_id,
                input.chapter_index,
                now,
            ],
        )
        .await?;

        let material_id = last_insert_rowid(conn).await?;

        // 2. Ensure every lemma exists; upsert every edge.
        for tok in &input.tokens {
            let lemma = tok.lemma.trim();
            if lemma.is_empty() {
                continue;
            }
            conn.execute(
                "INSERT OR IGNORE INTO words \
                   (lemma, state, state_source, created_at, updated_at, first_seen_at) \
                 VALUES (?1, 'unknown', 'import', ?2, ?2, ?2)",
                turso::params![lemma, now],
            )
            .await?;

            let word_id = lookup_word_id(conn, lemma).await?;
            if let Some(word_id) = word_id {
                conn.execute(
                    "INSERT INTO word_materials \
                       (word_id, material_id, occurrence_count, first_position, sentence_preview) \
                     VALUES (?1, ?2, ?3, ?4, ?5) \
                     ON CONFLICT(word_id, material_id) DO UPDATE SET \
                       occurrence_count = excluded.occurrence_count, \
                       first_position   = excluded.first_position, \
                       sentence_preview = excluded.sentence_preview",
                    turso::params![
                        word_id,
                        material_id,
                        tok.occurrence_count,
                        tok.first_position,
                        tok.sentence_preview.as_deref(),
                    ],
                )
                .await?;
            }
        }

        // 3. Unknown count = distinct lemmas attached to this material whose
        //    state is not 'known'. We count learning + unknown as "still not
        //    known" so the library view and recommender agree on ratio.
        let mut rows = conn
            .query(
                "SELECT COUNT(DISTINCT wm.word_id) \
                   FROM word_materials wm \
                   JOIN words w ON w.id = wm.word_id \
                  WHERE wm.material_id = ?1 AND w.state <> 'known'",
                turso::params![material_id],
            )
            .await?;
        let unknown_count_at_import: i64 = if let Some(row) = rows.next().await? {
            row.get::<i64>(0)?
        } else {
            0
        };

        conn.execute(
            "UPDATE materials SET unknown_count_at_import = ?1 WHERE id = ?2",
            turso::params![unknown_count_at_import, material_id],
        )
        .await?;

        Ok(SaveMaterialOutput {
            material_id,
            unknown_count_at_import,
            total_tokens: input.total_tokens,
            unique_tokens: input.unique_tokens,
        })
    }
    .await;

    match tx_result {
        Ok(out) => {
            conn.execute("COMMIT;", ()).await?;
            Ok(out)
        }
        Err(e) => {
            let _ = conn.execute("ROLLBACK;", ()).await;
            Err(e)
        }
    }
}

pub async fn save_material(input: &SaveMaterialInput) -> DbResult<SaveMaterialOutput> {
    let conn = get_connection()?.lock().await;
    save_material_on_conn(&conn, input).await
}

// ---------------------------------------------------------------------------
// Library view
// ---------------------------------------------------------------------------

/// Every material, newest first, with live unknown counts.
///
/// The library view only shows root materials (books + standalone docs). EPUB
/// chapters (`parent_material_id IS NOT NULL`) are fetched separately via
/// [`list_child_materials`] when the user opens the chapter picker.
pub async fn list_materials_on_conn(conn: &Connection) -> DbResult<Vec<MaterialSummary>> {
    let mut rows = conn
        .query(
            "SELECT m.id, m.title, m.source_kind, m.total_tokens, m.unique_tokens, \
                    m.unknown_count_at_import, m.created_at, m.read_at, \
                    m.parent_material_id, m.chapter_index, \
                    COALESCE((SELECT COUNT(DISTINCT wm.word_id) \
                               FROM word_materials wm \
                               JOIN words w ON w.id = wm.word_id \
                              WHERE wm.material_id = m.id AND w.state <> 'known'), 0) \
                      AS unknown_count \
               FROM materials m \
              WHERE m.parent_material_id IS NULL \
              ORDER BY m.created_at DESC",
            (),
        )
        .await?;

    let mut out = Vec::new();
    while let Some(row) = rows.next().await? {
        out.push(MaterialSummary {
            id: row.get::<i64>(0)?,
            title: row.get::<String>(1)?,
            source_kind: row.get::<String>(2)?,
            total_tokens: row.get::<i64>(3)?,
            unique_tokens: row.get::<i64>(4)?,
            unknown_count_at_import: row.get::<i64>(5)?,
            created_at: row.get::<i64>(6)?,
            read_at: nullable_i64(&row, 7)?,
            parent_material_id: nullable_i64(&row, 8)?,
            chapter_index: nullable_i64(&row, 9)?,
            unknown_count: row.get::<i64>(10)?,
        });
    }
    Ok(out)
}

pub async fn list_materials() -> DbResult<Vec<MaterialSummary>> {
    let conn = get_connection()?.lock().await;
    list_materials_on_conn(&conn).await
}

/// Chapters of a given book-level material, ordered by `chapter_index`.
pub async fn list_child_materials_on_conn(
    conn: &Connection,
    parent_id: i64,
) -> DbResult<Vec<MaterialSummary>> {
    let mut rows = conn
        .query(
            "SELECT m.id, m.title, m.source_kind, m.total_tokens, m.unique_tokens, \
                    m.unknown_count_at_import, m.created_at, m.read_at, \
                    m.parent_material_id, m.chapter_index, \
                    COALESCE((SELECT COUNT(DISTINCT wm.word_id) \
                               FROM word_materials wm \
                               JOIN words w ON w.id = wm.word_id \
                              WHERE wm.material_id = m.id AND w.state <> 'known'), 0) \
                      AS unknown_count \
               FROM materials m \
              WHERE m.parent_material_id = ?1 \
              ORDER BY COALESCE(m.chapter_index, 0) ASC",
            turso::params![parent_id],
        )
        .await?;

    let mut out = Vec::new();
    while let Some(row) = rows.next().await? {
        out.push(MaterialSummary {
            id: row.get::<i64>(0)?,
            title: row.get::<String>(1)?,
            source_kind: row.get::<String>(2)?,
            total_tokens: row.get::<i64>(3)?,
            unique_tokens: row.get::<i64>(4)?,
            unknown_count_at_import: row.get::<i64>(5)?,
            created_at: row.get::<i64>(6)?,
            read_at: nullable_i64(&row, 7)?,
            parent_material_id: nullable_i64(&row, 8)?,
            chapter_index: nullable_i64(&row, 9)?,
            unknown_count: row.get::<i64>(10)?,
        });
    }
    Ok(out)
}

pub async fn list_child_materials(parent_id: i64) -> DbResult<Vec<MaterialSummary>> {
    let conn = get_connection()?.lock().await;
    list_child_materials_on_conn(&conn, parent_id).await
}

/// Full payload for a single material — body + tiptap JSON. Powers
/// "open in reader" from the library and the EPUB chapter picker.
pub async fn load_material_on_conn(conn: &Connection, id: i64) -> DbResult<Option<MaterialFull>> {
    let mut rows = conn
        .query(
            "SELECT id, title, source_kind, origin_path, raw_text, tiptap_json, \
                    total_tokens, unique_tokens, created_at, read_at, \
                    parent_material_id, chapter_index \
               FROM materials WHERE id = ?1",
            turso::params![id],
        )
        .await?;
    if let Some(row) = rows.next().await? {
        Ok(Some(MaterialFull {
            id: row.get::<i64>(0)?,
            title: row.get::<String>(1)?,
            source_kind: row.get::<String>(2)?,
            origin_path: nullable_string(&row, 3)?,
            raw_text: row.get::<String>(4)?,
            tiptap_json: row.get::<String>(5)?,
            total_tokens: row.get::<i64>(6)?,
            unique_tokens: row.get::<i64>(7)?,
            created_at: row.get::<i64>(8)?,
            read_at: nullable_i64(&row, 9)?,
            parent_material_id: nullable_i64(&row, 10)?,
            chapter_index: nullable_i64(&row, 11)?,
        }))
    } else {
        Ok(None)
    }
}

pub async fn load_material(id: i64) -> DbResult<Option<MaterialFull>> {
    let conn = get_connection()?.lock().await;
    load_material_on_conn(&conn, id).await
}

/// Every material containing `lemma`, newest first. Powers the Word → Docs drawer.
pub async fn materials_for_word_on_conn(
    conn: &Connection,
    lemma: &str,
) -> DbResult<Vec<MaterialForWord>> {
    let mut rows = conn
        .query(
            "SELECT m.id, m.title, m.created_at, m.read_at, \
                    wm.occurrence_count, wm.first_position, wm.sentence_preview \
               FROM materials m \
               JOIN word_materials wm ON wm.material_id = m.id \
               JOIN words w ON w.id = wm.word_id \
              WHERE w.lemma = ?1 \
              ORDER BY m.created_at DESC",
            turso::params![lemma],
        )
        .await?;

    let mut out = Vec::new();
    while let Some(row) = rows.next().await? {
        out.push(MaterialForWord {
            material_id: row.get::<i64>(0)?,
            title: row.get::<String>(1)?,
            created_at: row.get::<i64>(2)?,
            read_at: nullable_i64(&row, 3)?,
            occurrence_count: row.get::<i64>(4)?,
            first_position: row.get::<i64>(5)?,
            sentence_preview: nullable_string(&row, 6)?,
        });
    }
    Ok(out)
}

pub async fn materials_for_word(lemma: &str) -> DbResult<Vec<MaterialForWord>> {
    let conn = get_connection()?.lock().await;
    materials_for_word_on_conn(&conn, lemma).await
}

// ---------------------------------------------------------------------------
// Auto-exposure: bump counters on close + auto-graduate.
// ---------------------------------------------------------------------------

/// Increment `exposure_count` on every lemma in this material, then auto-
/// graduate (unknown→learning, learning→known) any row whose counter meets
/// the threshold. Returns the lemmas that graduated in each direction so the
/// UI can surface a "graduated N words — undo?" toast.
pub async fn record_material_close_on_conn(
    conn: &Connection,
    material_id: i64,
    threshold: i64,
) -> DbResult<MaterialCloseOutcome> {
    let now = now_ms();

    conn.execute("BEGIN IMMEDIATE;", ()).await?;
    let tx: DbResult<MaterialCloseOutcome> = async {
        // 1. Mark the material as read.
        conn.execute(
            "UPDATE materials SET read_at = ?1 WHERE id = ?2",
            turso::params![now, material_id],
        )
        .await?;

        // 2. Bump exposure_count for every word in this material.
        conn.execute(
            "UPDATE words \
                SET exposure_count = exposure_count + 1, updated_at = ?1 \
              WHERE id IN (SELECT word_id FROM word_materials WHERE material_id = ?2)",
            turso::params![now, material_id],
        )
        .await?;

        // IMPORTANT: we process `learning → known` BEFORE `unknown → learning`
        // so each material-close only advances a lemma by a single stage. If
        // we ran them in the other order, the 5th close would promote a fresh
        // word all the way from `unknown` through `learning` to `known` in a
        // single atomic UPDATE because the row already satisfies the second
        // predicate by the time we evaluate it.

        // 3a. Promote learning → known (only rows that were ALREADY learning
        //     at the top of this close transition).
        let mut rows = conn
            .query(
                "SELECT w.lemma FROM words w \
                   JOIN word_materials wm ON wm.word_id = w.id \
                  WHERE wm.material_id = ?1 \
                    AND w.state = 'learning' \
                    AND w.exposure_count >= ?2",
                turso::params![material_id, threshold],
            )
            .await?;
        let mut graduated_known = Vec::new();
        while let Some(row) = rows.next().await? {
            graduated_known.push(row.get::<String>(0)?);
        }
        drop(rows);
        if !graduated_known.is_empty() {
            conn.execute(
                "UPDATE words \
                    SET state = 'known', state_source = 'auto_exposure', \
                        marked_known_at = ?1, updated_at = ?1 \
                  WHERE id IN (SELECT wm.word_id FROM word_materials wm \
                                WHERE wm.material_id = ?2) \
                    AND state = 'learning' \
                    AND exposure_count >= ?3",
                turso::params![now, material_id, threshold],
            )
            .await?;
        }

        // 3b. Promote unknown → learning.
        let mut rows = conn
            .query(
                "SELECT w.lemma FROM words w \
                   JOIN word_materials wm ON wm.word_id = w.id \
                  WHERE wm.material_id = ?1 \
                    AND w.state = 'unknown' \
                    AND w.exposure_count >= ?2",
                turso::params![material_id, threshold],
            )
            .await?;
        let mut graduated_learning = Vec::new();
        while let Some(row) = rows.next().await? {
            graduated_learning.push(row.get::<String>(0)?);
        }
        drop(rows);
        if !graduated_learning.is_empty() {
            conn.execute(
                "UPDATE words \
                    SET state = 'learning', state_source = 'auto_exposure', updated_at = ?1 \
                  WHERE id IN (SELECT wm.word_id FROM word_materials wm \
                                WHERE wm.material_id = ?2) \
                    AND state = 'unknown' \
                    AND exposure_count >= ?3",
                turso::params![now, material_id, threshold],
            )
            .await?;
        }

        Ok(MaterialCloseOutcome {
            graduated_to_learning: graduated_learning,
            graduated_to_known: graduated_known,
            exposure_threshold: threshold,
        })
    }
    .await;

    match tx {
        Ok(v) => {
            conn.execute("COMMIT;", ()).await?;
            Ok(v)
        }
        Err(e) => {
            let _ = conn.execute("ROLLBACK;", ()).await;
            Err(e)
        }
    }
}

pub async fn record_material_close(material_id: i64, threshold: i64) -> DbResult<MaterialCloseOutcome> {
    let conn = get_connection()?.lock().await;
    record_material_close_on_conn(&conn, material_id, threshold).await
}

/// Reverse a previous auto-exposure graduation (best effort). Used by the
/// toast's "undo" action.
pub async fn undo_graduation_on_conn(
    conn: &Connection,
    lemmas_to_unknown: &[String],
    lemmas_to_learning: &[String],
) -> DbResult<()> {
    let now = now_ms();
    conn.execute("BEGIN IMMEDIATE;", ()).await?;
    let res: DbResult<()> = async {
        for lemma in lemmas_to_unknown {
            conn.execute(
                "UPDATE words \
                    SET state = 'unknown', state_source = NULL, \
                        marked_known_at = NULL, updated_at = ?1 \
                  WHERE lemma = ?2 AND state_source = 'auto_exposure'",
                turso::params![now, lemma.as_str()],
            )
            .await?;
        }
        for lemma in lemmas_to_learning {
            conn.execute(
                "UPDATE words \
                    SET state = 'learning', state_source = 'auto_exposure', \
                        marked_known_at = NULL, updated_at = ?1 \
                  WHERE lemma = ?2 AND state_source = 'auto_exposure'",
                turso::params![now, lemma.as_str()],
            )
            .await?;
        }
        Ok(())
    }
    .await;
    match res {
        Ok(()) => {
            conn.execute("COMMIT;", ()).await?;
            Ok(())
        }
        Err(e) => {
            let _ = conn.execute("ROLLBACK;", ()).await;
            Err(e)
        }
    }
}

pub async fn undo_graduation(
    lemmas_to_unknown: &[String],
    lemmas_to_learning: &[String],
) -> DbResult<()> {
    let conn = get_connection()?.lock().await;
    undo_graduation_on_conn(&conn, lemmas_to_unknown, lemmas_to_learning).await
}

// ---------------------------------------------------------------------------
// Next-doc recommender
// ---------------------------------------------------------------------------

/// Score = `|unknown_ratio − target| + length_penalty`. Lower is better.
///
/// The length penalty is a mild regulariser: all else equal, prefer docs close
/// to `ideal_length` tokens (default 1000). We cap at 0.01 so a great-ratio
/// document still wins against a mediocre-ratio one of ideal length.
pub fn score_material(unknown_ratio: f64, total_tokens: i64, target: f64) -> f64 {
    let ideal_length: f64 = 1000.0;
    let ratio_delta = (unknown_ratio - target).abs();
    let length_penalty = if total_tokens <= 0 {
        0.01
    } else {
        let diff = (total_tokens as f64 - ideal_length).abs() / ideal_length;
        (0.01_f64).min(diff * 0.01_f64)
    };
    ratio_delta + length_penalty
}

/// Score every unread material and return the top `limit` ordered by score.
pub async fn recommend_next_on_conn(
    conn: &Connection,
    target: f64,
    limit: usize,
) -> DbResult<Vec<RecommendedMaterial>> {
    let mut rows = conn
        .query(
            "SELECT m.id, m.title, m.total_tokens, m.unique_tokens, m.created_at, \
                    COALESCE((SELECT COUNT(DISTINCT wm.word_id) \
                               FROM word_materials wm \
                               JOIN words w ON w.id = wm.word_id \
                              WHERE wm.material_id = m.id AND w.state <> 'known'), 0) \
                      AS unknown_count \
               FROM materials m \
              WHERE m.read_at IS NULL",
            (),
        )
        .await?;

    let mut candidates: Vec<RecommendedMaterial> = Vec::new();
    while let Some(row) = rows.next().await? {
        let unique_tokens: i64 = row.get(3)?;
        let unknown_count: i64 = row.get(5)?;
        let unknown_ratio = if unique_tokens > 0 {
            (unknown_count as f64) / (unique_tokens as f64)
        } else {
            1.0
        };
        let total_tokens: i64 = row.get(2)?;
        let score = score_material(unknown_ratio, total_tokens, target);
        candidates.push(RecommendedMaterial {
            id: row.get::<i64>(0)?,
            title: row.get::<String>(1)?,
            total_tokens,
            unique_tokens,
            unknown_count,
            unknown_ratio,
            score,
            created_at: row.get::<i64>(4)?,
        });
    }

    candidates.sort_by(|a, b| {
        a.score
            .partial_cmp(&b.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    candidates.truncate(limit);
    Ok(candidates)
}

pub async fn recommend_next(target: f64, limit: usize) -> DbResult<Vec<RecommendedMaterial>> {
    let conn = get_connection()?.lock().await;
    recommend_next_on_conn(&conn, target, limit).await
}

// ---------------------------------------------------------------------------
// Tiny helpers.
// ---------------------------------------------------------------------------

async fn last_insert_rowid(conn: &Connection) -> DbResult<i64> {
    let mut rows = conn.query("SELECT last_insert_rowid()", ()).await?;
    if let Some(row) = rows.next().await? {
        Ok(row.get::<i64>(0)?)
    } else {
        Err("last_insert_rowid returned no rows".into())
    }
}

async fn lookup_word_id(conn: &Connection, lemma: &str) -> DbResult<Option<i64>> {
    let mut rows = conn
        .query(
            "SELECT id FROM words WHERE lemma = ?1",
            turso::params![lemma],
        )
        .await?;
    if let Some(row) = rows.next().await? {
        Ok(Some(row.get::<i64>(0)?))
    } else {
        Ok(None)
    }
}

fn nullable_i64(row: &turso::Row, col: usize) -> DbResult<Option<i64>> {
    match row.get_value(col)? {
        turso::Value::Null => Ok(None),
        turso::Value::Integer(i) => Ok(Some(i)),
        _ => Err("expected nullable integer column".into()),
    }
}

fn nullable_string(row: &turso::Row, col: usize) -> DbResult<Option<String>> {
    match row.get_value(col)? {
        turso::Value::Null => Ok(None),
        turso::Value::Text(s) => Ok(Some(s)),
        _ => Err("expected nullable text column".into()),
    }
}
