//! Writing Train persistence.
//!
//! Submissions are saved as `materials` rows with `source_kind = 'writing_submission'`
//! so they re-appear in the Library and contribute to the bipartite
//! `word_materials` graph just like any other reading material. The full
//! `WritingFeedback` payload (corrected text, diff spans, verdict, explanation,
//! synonym spans) lives alongside in `materials.mcq_payload` as a JSON blob —
//! we reuse the `mcq_payload` slot worker-schema added rather than introducing a
//! third TEXT column.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use turso::Connection;

use super::{get_connection, now_ms, DbResult};

/// `source_kind` value the IPC handler must validate before INSERTing — SQLite
/// can't gain a CHECK constraint via ALTER, so the enum lives at the IPC edge.
pub const SOURCE_KIND_WRITING_SUBMISSION: &str = "writing_submission";

/// Diff span returned by the AI grader. Mirrors the JSON the prompt schema
/// declares (see `ai::prompts::writing_grade::schema`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiffSpan {
    pub from: i64,
    pub to: i64,
    pub kind: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SynonymSpan {
    pub from: i64,
    pub to: i64,
    pub synonyms: Vec<String>,
}

/// Full feedback object returned to the renderer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WritingFeedback {
    pub material_id: i64,
    pub corrected_text: String,
    pub diff_spans: Vec<DiffSpan>,
    pub usage_verdict: String,
    pub usage_explanation: String,
    pub synonym_spans: Vec<SynonymSpan>,
    /// Post-increment usage counter for the target word (after the +1 from
    /// `register_word_use`).
    pub new_usage_count: i64,
}

#[derive(Debug, Clone)]
pub struct WritingInsertInput<'a> {
    pub title: &'a str,
    pub raw_text: &'a str,
    pub corrected_text: &'a str,
    pub tiptap_json: &'a str,
    pub feedback_payload: &'a Value,
    pub word_ids: &'a [i64],
    pub total_tokens: i64,
    pub unique_tokens: i64,
}

/// Persist one writing submission. Returns the new `materials.id`.
pub async fn insert_writing_on_conn(
    conn: &Connection,
    input: &WritingInsertInput<'_>,
) -> DbResult<i64> {
    let now = now_ms();

    conn.execute("BEGIN IMMEDIATE;", ()).await?;
    let tx: DbResult<i64> = async {
        conn.execute(
            "INSERT INTO materials \
               (title, source_kind, origin_path, tiptap_json, raw_text, \
                total_tokens, unique_tokens, unknown_count_at_import, \
                parent_material_id, chapter_index, mcq_payload, created_at) \
             VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, 0, NULL, NULL, ?7, ?8)",
            turso::params![
                input.title,
                SOURCE_KIND_WRITING_SUBMISSION,
                input.tiptap_json,
                input.raw_text,
                input.total_tokens,
                input.unique_tokens,
                input.feedback_payload.to_string(),
                now,
            ],
        )
        .await?;

        let material_id = last_insert_rowid(conn).await?;

        for (i, word_id) in input.word_ids.iter().enumerate() {
            conn.execute(
                "INSERT INTO word_materials \
                   (word_id, material_id, occurrence_count, first_position, sentence_preview) \
                 VALUES (?1, ?2, ?3, ?4, ?5) \
                 ON CONFLICT(word_id, material_id) DO UPDATE SET \
                   occurrence_count = excluded.occurrence_count, \
                   first_position   = excluded.first_position, \
                   sentence_preview = excluded.sentence_preview",
                turso::params![
                    *word_id,
                    material_id,
                    1_i64,
                    i as i64,
                    Some(input.corrected_text),
                ],
            )
            .await?;
        }

        let mut rows = conn
            .query(
                "SELECT COUNT(DISTINCT wm.word_id) FROM word_materials wm \
                   JOIN words w ON w.id = wm.word_id \
                  WHERE wm.material_id = ?1 AND w.state <> 'known'",
                turso::params![material_id],
            )
            .await?;
        let unknown_count: i64 = if let Some(row) = rows.next().await? {
            row.get::<i64>(0)?
        } else {
            0
        };
        drop(rows);
        conn.execute(
            "UPDATE materials SET unknown_count_at_import = ?1 WHERE id = ?2",
            turso::params![unknown_count, material_id],
        )
        .await?;

        Ok(material_id)
    }
    .await;

    match tx {
        Ok(id) => {
            conn.execute("COMMIT;", ()).await?;
            Ok(id)
        }
        Err(e) => {
            let _ = conn.execute("ROLLBACK;", ()).await;
            Err(e)
        }
    }
}

pub async fn insert_writing(input: &WritingInsertInput<'_>) -> DbResult<i64> {
    let conn = get_connection()?.lock().await;
    insert_writing_on_conn(&conn, input).await
}

/// Resolve every lemma in `lemmas` to its `(id, lemma)` pair. Lemmas absent
/// from the `words` table are silently dropped — only matching rows come back.
pub async fn resolve_lemmas_on_conn(
    conn: &Connection,
    lemmas: &[String],
) -> DbResult<Vec<(i64, String)>> {
    let mut out = Vec::with_capacity(lemmas.len());
    for lemma in lemmas {
        let key = lemma.trim().to_ascii_lowercase();
        if key.is_empty() {
            continue;
        }
        let mut rows = conn
            .query(
                "SELECT id, lemma FROM words WHERE lemma = ?1",
                turso::params![key],
            )
            .await?;
        if let Some(row) = rows.next().await? {
            out.push((row.get::<i64>(0)?, row.get::<String>(1)?));
        }
    }
    Ok(out)
}

pub async fn resolve_lemmas(lemmas: &[String]) -> DbResult<Vec<(i64, String)>> {
    let conn = get_connection()?.lock().await;
    resolve_lemmas_on_conn(&conn, lemmas).await
}

/// Pull the top `limit` lemmas where `state='known'`, ordered by the smallest
/// (most common) `freq_rank`. Used to bound the prompt's known-words list so
/// the writing-grade explanation only uses words the learner already knows.
pub async fn top_known_by_freq_on_conn(conn: &Connection, limit: u32) -> DbResult<Vec<String>> {
    let mut rows = conn
        .query(
            "SELECT lemma FROM words \
              WHERE state = 'known' AND freq_rank IS NOT NULL \
              ORDER BY freq_rank ASC \
              LIMIT ?1",
            turso::params![limit as i64],
        )
        .await?;
    let mut out = Vec::with_capacity(limit as usize);
    while let Some(row) = rows.next().await? {
        out.push(row.get::<String>(0)?);
    }
    Ok(out)
}

pub async fn top_known_by_freq(limit: u32) -> DbResult<Vec<String>> {
    let conn = get_connection()?.lock().await;
    top_known_by_freq_on_conn(&conn, limit).await
}

async fn last_insert_rowid(conn: &Connection) -> DbResult<i64> {
    let mut rows = conn.query("SELECT last_insert_rowid()", ()).await?;
    if let Some(row) = rows.next().await? {
        Ok(row.get::<i64>(0)?)
    } else {
        Err("last_insert_rowid returned no rows".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use turso::Builder;

    async fn setup_db() -> Connection {
        let db = Builder::new_local(":memory:")
            .build()
            .await
            .expect("build in-memory turso");
        let conn = db.connect().expect("connect in-memory turso");
        crate::db::schema::apply(&conn).await.expect("apply schema");
        conn
    }

    async fn seed_word(conn: &Connection, lemma: &str, state: &str, freq_rank: Option<i64>) -> i64 {
        let now = now_ms();
        conn.execute(
            "INSERT INTO words \
               (lemma, state, state_source, freq_rank, first_seen_at, created_at, updated_at) \
             VALUES (?1, ?2, 'test', ?3, ?4, ?4, ?4)",
            turso::params![lemma, state, freq_rank, now],
        )
        .await
        .unwrap();
        let mut rows = conn
            .query(
                "SELECT id FROM words WHERE lemma = ?1",
                turso::params![lemma],
            )
            .await
            .unwrap();
        rows.next().await.unwrap().unwrap().get(0).unwrap()
    }

    #[tokio::test]
    async fn insert_writing_persists_material_and_edges() {
        let conn = setup_db().await;
        let alpha = seed_word(&conn, "alpha", "learning", Some(100)).await;

        let payload = serde_json::json!({
            "corrected_text": "alpha is brilliant.",
            "usage_verdict": "correct",
        });
        let input = WritingInsertInput {
            title: "alpha · writing",
            raw_text: "alpha: i think alpha is brilliant.",
            corrected_text: "alpha is brilliant.",
            tiptap_json: "{\"type\":\"doc\",\"content\":[]}",
            feedback_payload: &payload,
            word_ids: &[alpha],
            total_tokens: 5,
            unique_tokens: 4,
        };
        let id = insert_writing_on_conn(&conn, &input).await.unwrap();
        assert!(id > 0);

        // The materials row exists with the right source_kind + payload.
        let mut rows = conn
            .query(
                "SELECT source_kind, mcq_payload FROM materials WHERE id = ?1",
                turso::params![id],
            )
            .await
            .unwrap();
        let row = rows.next().await.unwrap().unwrap();
        let kind: String = row.get(0).unwrap();
        let payload_str: String = row.get(1).unwrap();
        assert_eq!(kind, SOURCE_KIND_WRITING_SUBMISSION);
        assert!(payload_str.contains("brilliant"));

        // Edge exists for the target word.
        let mut rows = conn
            .query(
                "SELECT word_id FROM word_materials WHERE material_id = ?1",
                turso::params![id],
            )
            .await
            .unwrap();
        let mut ids = Vec::new();
        while let Some(r) = rows.next().await.unwrap() {
            ids.push(r.get::<i64>(0).unwrap());
        }
        assert_eq!(ids, vec![alpha]);
    }

    #[tokio::test]
    async fn resolve_lemmas_skips_missing_and_lowercases() {
        let conn = setup_db().await;
        seed_word(&conn, "alpha", "learning", None).await;
        seed_word(&conn, "bravo", "learning", None).await;

        let resolved = resolve_lemmas_on_conn(
            &conn,
            &[
                "Alpha".to_string(),
                "  bravo  ".to_string(),
                "missing".to_string(),
                "".to_string(),
            ],
        )
        .await
        .unwrap();
        let lemmas: Vec<&str> = resolved.iter().map(|(_, l)| l.as_str()).collect();
        assert_eq!(lemmas, vec!["alpha", "bravo"]);
    }

    #[tokio::test]
    async fn top_known_by_freq_orders_by_rank_ascending() {
        let conn = setup_db().await;
        seed_word(&conn, "the", "known", Some(1)).await;
        seed_word(&conn, "a", "known", Some(5)).await;
        seed_word(&conn, "alpha", "known", Some(10)).await;
        // Excluded — not known.
        seed_word(&conn, "bravo", "learning", Some(2)).await;
        // Excluded — no freq_rank.
        seed_word(&conn, "charlie", "known", None).await;

        let out = top_known_by_freq_on_conn(&conn, 10).await.unwrap();
        assert_eq!(out, vec!["the", "a", "alpha"]);
    }
}
