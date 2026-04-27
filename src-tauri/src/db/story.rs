//! Story Review persistence.
//!
//! Stories are saved as `materials` rows with `source_kind = 'ai_story'` so
//! they re-appear in the Library and contribute to the bipartite
//! `word_materials` graph just like any other reading material. The MCQ
//! payload (blanks + options + correct indices) lives in `materials.mcq_payload`
//! as a JSON blob; the renderable story text (with `{{N}}` placeholders) lives
//! in `materials.tiptap_json` so opening a story from the Library re-hydrates
//! the same view.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use turso::Connection;

use super::{get_connection, now_ms, DbResult};

/// `source_kind` value the IPC handler must validate before INSERTing — SQLite
/// can't gain a CHECK constraint via ALTER, so the enum lives at the IPC edge.
pub const SOURCE_KIND_AI_STORY: &str = "ai_story";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClozeBlank {
    pub index: i64,
    pub target_word_id: i64,
    pub options: Vec<String>,
    pub correct_index: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct StoryMaterial {
    pub material_id: i64,
    /// The story body with `{{1}}`, `{{2}}`, ... blank placeholders rendered
    /// into the Story Review surface (in-document order).
    pub story_text: String,
    /// Tiptap doc JSON for the same content; persisted alongside on materials.
    pub tiptap_json: String,
    pub blanks: Vec<ClozeBlank>,
}

#[derive(Debug, Clone)]
pub struct StoryInsertInput<'a> {
    pub title: &'a str,
    /// Body with `{{N}}` placeholders (what the renderer needs).
    pub story_text_placeholders: &'a str,
    /// Body with literal `____` blanks (Library-readable form).
    pub raw_text: &'a str,
    pub tiptap_json: &'a str,
    pub mcq_payload: &'a Value,
    /// Edges to upsert into `word_materials`. The story should already
    /// reference each blank's target word.
    pub word_ids: &'a [i64],
    pub total_tokens: i64,
    pub unique_tokens: i64,
    pub blanks: &'a [ClozeBlank],
}

/// Persist one story. Returns the `StoryMaterial` shape the IPC layer hands to
/// the renderer.
pub async fn insert_story_on_conn(
    conn: &Connection,
    input: &StoryInsertInput<'_>,
) -> DbResult<StoryMaterial> {
    let now = now_ms();

    conn.execute("BEGIN IMMEDIATE;", ()).await?;
    let tx: DbResult<StoryMaterial> = async {
        // 1. Insert the materials row. We store `raw_text` (with `____` blanks)
        //    so opening the story from the Library renders cleanly without the
        //    placeholder syntax leaking into the prose; `tiptap_json` carries
        //    the placeholder-bearing form for the StoryView re-hydration.
        conn.execute(
            "INSERT INTO materials \
               (title, source_kind, origin_path, tiptap_json, raw_text, \
                total_tokens, unique_tokens, unknown_count_at_import, \
                parent_material_id, chapter_index, mcq_payload, created_at) \
             VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, 0, NULL, NULL, ?7, ?8)",
            turso::params![
                input.title,
                SOURCE_KIND_AI_STORY,
                input.tiptap_json,
                input.raw_text,
                input.total_tokens,
                input.unique_tokens,
                input.mcq_payload.to_string(),
                now,
            ],
        )
        .await?;

        let material_id = last_insert_rowid(conn).await?;

        // 2. Upsert word_materials edges for every target word. We mirror the
        //    pattern in `db::materials::save_material_on_conn` (same UPSERT
        //    column set) so the two ingest paths agree on schema.
        for (i, word_id) in input.word_ids.iter().enumerate() {
            conn.execute(
                "INSERT INTO word_materials \
                   (word_id, material_id, occurrence_count, first_position, sentence_preview) \
                 VALUES (?1, ?2, ?3, ?4, NULL) \
                 ON CONFLICT(word_id, material_id) DO UPDATE SET \
                   occurrence_count = excluded.occurrence_count, \
                   first_position   = excluded.first_position",
                turso::params![word_id, material_id, 1_i64, i as i64],
            )
            .await?;
        }

        // 3. Update unknown_count_at_import the same way save_material does.
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

        Ok(StoryMaterial {
            material_id,
            story_text: input.story_text_placeholders.to_string(),
            tiptap_json: input.tiptap_json.to_string(),
            blanks: input.blanks.to_vec(),
        })
    }
    .await;

    match tx {
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

pub async fn insert_story(input: &StoryInsertInput<'_>) -> DbResult<StoryMaterial> {
    let conn = get_connection()?.lock().await;
    insert_story_on_conn(&conn, input).await
}

/// Look up `(id, lemma)` for a list of word ids in input order. Missing ids
/// are silently skipped — the caller validates non-emptiness.
pub async fn lookup_words_on_conn(
    conn: &Connection,
    word_ids: &[i64],
) -> DbResult<Vec<(i64, String)>> {
    let mut out = Vec::with_capacity(word_ids.len());
    for id in word_ids {
        let mut rows = conn
            .query(
                "SELECT id, lemma FROM words WHERE id = ?1",
                turso::params![*id],
            )
            .await?;
        if let Some(row) = rows.next().await? {
            out.push((row.get::<i64>(0)?, row.get::<String>(1)?));
        }
    }
    Ok(out)
}

pub async fn lookup_words(word_ids: &[i64]) -> DbResult<Vec<(i64, String)>> {
    let conn = get_connection()?.lock().await;
    lookup_words_on_conn(&conn, word_ids).await
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

    async fn seed_word(conn: &Connection, lemma: &str) -> i64 {
        let now = now_ms();
        conn.execute(
            "INSERT INTO words (lemma, state, state_source, first_seen_at, created_at, updated_at) \
             VALUES (?1, 'learning', 'test', ?2, ?2, ?2)",
            turso::params![lemma, now],
        )
        .await
        .unwrap();
        let mut rows = conn
            .query("SELECT id FROM words WHERE lemma = ?1", turso::params![lemma])
            .await
            .unwrap();
        rows.next().await.unwrap().unwrap().get(0).unwrap()
    }

    #[tokio::test]
    async fn insert_story_persists_material_and_edges() {
        let conn = setup_db().await;
        let alpha = seed_word(&conn, "alpha").await;
        let bravo = seed_word(&conn, "bravo").await;

        let blanks = vec![
            ClozeBlank {
                index: 0,
                target_word_id: alpha,
                options: vec![
                    "alpha".into(),
                    "alike".into(),
                    "alley".into(),
                    "alpine".into(),
                ],
                correct_index: 0,
            },
            ClozeBlank {
                index: 1,
                target_word_id: bravo,
                options: vec![
                    "bravo".into(),
                    "brave".into(),
                    "broad".into(),
                    "brand".into(),
                ],
                correct_index: 0,
            },
        ];
        let payload = serde_json::json!({ "blanks": blanks });
        let input = StoryInsertInput {
            title: "Daily Story",
            story_text_placeholders: "He said {{1}} and waved {{2}}.",
            raw_text: "He said ____ and waved ____.",
            tiptap_json: "{\"type\":\"doc\",\"content\":[]}",
            mcq_payload: &payload,
            word_ids: &[alpha, bravo],
            total_tokens: 6,
            unique_tokens: 5,
            blanks: &blanks,
        };

        let story = insert_story_on_conn(&conn, &input).await.unwrap();
        assert!(story.material_id > 0);
        assert_eq!(story.blanks.len(), 2);
        assert!(story.story_text.contains("{{1}}"));
        assert!(story.story_text.contains("{{2}}"));

        // The materials row exists with the right source_kind + payload.
        let mut rows = conn
            .query(
                "SELECT source_kind, mcq_payload, raw_text FROM materials WHERE id = ?1",
                turso::params![story.material_id],
            )
            .await
            .unwrap();
        let row = rows.next().await.unwrap().unwrap();
        let kind: String = row.get(0).unwrap();
        let payload_str: String = row.get(1).unwrap();
        let raw: String = row.get(2).unwrap();
        assert_eq!(kind, SOURCE_KIND_AI_STORY);
        assert!(payload_str.contains("alpha"));
        assert!(raw.contains("____"));

        // Bipartite edges exist for both target words.
        let mut rows = conn
            .query(
                "SELECT word_id FROM word_materials WHERE material_id = ?1 ORDER BY word_id",
                turso::params![story.material_id],
            )
            .await
            .unwrap();
        let mut ids = Vec::new();
        while let Some(r) = rows.next().await.unwrap() {
            ids.push(r.get::<i64>(0).unwrap());
        }
        let mut expected = vec![alpha, bravo];
        expected.sort();
        ids.sort();
        assert_eq!(ids, expected);
    }
}
