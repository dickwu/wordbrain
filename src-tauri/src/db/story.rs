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

#[derive(Debug, Clone, Serialize)]
pub struct StoryHistoryItem {
    pub material_id: i64,
    pub title: String,
    pub created_at: i64,
    pub read_at: Option<i64>,
    pub blank_count: i64,
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

        // 2. Upsert word_materials edges for every target word and refresh the
        //    same unknown count the normal material ingest path records.
        replace_story_edges(conn, material_id, input.word_ids).await?;
        refresh_unknown_count(conn, material_id).await?;

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

/// Overwrite an existing AI story material in place. The caller is expected to
/// compose and validate the replacement before calling this function, so a
/// failed AI response leaves the old story untouched.
pub async fn replace_story_on_conn(
    conn: &Connection,
    material_id: i64,
    input: &StoryInsertInput<'_>,
) -> DbResult<StoryMaterial> {
    let now = now_ms();

    conn.execute("BEGIN IMMEDIATE;", ()).await?;
    let tx: DbResult<StoryMaterial> = async {
        let mut rows = conn
            .query(
                "SELECT source_kind FROM materials WHERE id = ?1",
                turso::params![material_id],
            )
            .await?;
        let source_kind = if let Some(row) = rows.next().await? {
            row.get::<String>(0)?
        } else {
            return Err(format!("story material {material_id} not found").into());
        };
        drop(rows);
        if source_kind != SOURCE_KIND_AI_STORY {
            return Err(format!("material {material_id} is not an AI story").into());
        }

        conn.execute(
            "UPDATE materials \
                SET title = ?1, tiptap_json = ?2, raw_text = ?3, \
                    total_tokens = ?4, unique_tokens = ?5, \
                    unknown_count_at_import = 0, mcq_payload = ?6, created_at = ?7 \
              WHERE id = ?8",
            turso::params![
                input.title,
                input.tiptap_json,
                input.raw_text,
                input.total_tokens,
                input.unique_tokens,
                input.mcq_payload.to_string(),
                now,
                material_id,
            ],
        )
        .await?;

        conn.execute(
            "DELETE FROM word_materials WHERE material_id = ?1",
            turso::params![material_id],
        )
        .await?;
        replace_story_edges(conn, material_id, input.word_ids).await?;
        refresh_unknown_count(conn, material_id).await?;

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

pub async fn replace_story(
    material_id: i64,
    input: &StoryInsertInput<'_>,
) -> DbResult<StoryMaterial> {
    let conn = get_connection()?.lock().await;
    replace_story_on_conn(&conn, material_id, input).await
}

pub async fn list_story_history_on_conn(conn: &Connection) -> DbResult<Vec<StoryHistoryItem>> {
    let mut rows = conn
        .query(
            "SELECT id, title, created_at, read_at, mcq_payload \
               FROM materials \
              WHERE source_kind = ?1 \
              ORDER BY created_at DESC, id DESC",
            turso::params![SOURCE_KIND_AI_STORY],
        )
        .await?;

    let mut out = Vec::new();
    while let Some(row) = rows.next().await? {
        let payload = nullable_string(&row, 4)?;
        out.push(StoryHistoryItem {
            material_id: row.get::<i64>(0)?,
            title: row.get::<String>(1)?,
            created_at: row.get::<i64>(2)?,
            read_at: nullable_i64(&row, 3)?,
            blank_count: blank_count(payload.as_deref()) as i64,
        });
    }
    Ok(out)
}

pub async fn list_story_history() -> DbResult<Vec<StoryHistoryItem>> {
    let conn = get_connection()?.lock().await;
    list_story_history_on_conn(&conn).await
}

pub async fn load_story_on_conn(
    conn: &Connection,
    material_id: i64,
) -> DbResult<Option<StoryMaterial>> {
    let mut rows = conn
        .query(
            "SELECT id, tiptap_json, raw_text, mcq_payload \
               FROM materials \
              WHERE id = ?1 AND source_kind = ?2",
            turso::params![material_id, SOURCE_KIND_AI_STORY],
        )
        .await?;

    if let Some(row) = rows.next().await? {
        let material_id = row.get::<i64>(0)?;
        let tiptap_json = row.get::<String>(1)?;
        let raw_text = row.get::<String>(2)?;
        let payload = nullable_string(&row, 3)?
            .ok_or_else(|| format!("story material {material_id} is missing mcq_payload"))?;
        Ok(Some(story_from_parts(
            material_id,
            tiptap_json,
            raw_text,
            payload,
        )?))
    } else {
        Ok(None)
    }
}

pub async fn load_story(material_id: i64) -> DbResult<Option<StoryMaterial>> {
    let conn = get_connection()?.lock().await;
    load_story_on_conn(&conn, material_id).await
}

pub async fn delete_story_on_conn(conn: &Connection, material_id: i64) -> DbResult<bool> {
    conn.execute("BEGIN IMMEDIATE;", ()).await?;
    let tx: DbResult<bool> = async {
        let mut rows = conn
            .query(
                "SELECT source_kind FROM materials WHERE id = ?1",
                turso::params![material_id],
            )
            .await?;
        let source_kind = if let Some(row) = rows.next().await? {
            row.get::<String>(0)?
        } else {
            return Ok(false);
        };
        drop(rows);
        if source_kind != SOURCE_KIND_AI_STORY {
            return Err(format!("material {material_id} is not an AI story").into());
        }

        conn.execute(
            "DELETE FROM word_materials WHERE material_id = ?1",
            turso::params![material_id],
        )
        .await?;
        conn.execute(
            "DELETE FROM materials WHERE id = ?1",
            turso::params![material_id],
        )
        .await?;
        Ok(true)
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

pub async fn delete_story(material_id: i64) -> DbResult<bool> {
    let conn = get_connection()?.lock().await;
    delete_story_on_conn(&conn, material_id).await
}

pub async fn story_word_ids_on_conn(conn: &Connection, material_id: i64) -> DbResult<Vec<i64>> {
    let mut rows = conn
        .query(
            "SELECT wm.word_id \
               FROM word_materials wm \
               JOIN materials m ON m.id = wm.material_id \
              WHERE wm.material_id = ?1 AND m.source_kind = ?2 \
              ORDER BY wm.first_position ASC, wm.word_id ASC",
            turso::params![material_id, SOURCE_KIND_AI_STORY],
        )
        .await?;

    let mut out = Vec::new();
    while let Some(row) = rows.next().await? {
        out.push(row.get::<i64>(0)?);
    }
    Ok(out)
}

pub async fn story_word_ids(material_id: i64) -> DbResult<Vec<i64>> {
    let conn = get_connection()?.lock().await;
    story_word_ids_on_conn(&conn, material_id).await
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

async fn replace_story_edges(
    conn: &Connection,
    material_id: i64,
    word_ids: &[i64],
) -> DbResult<()> {
    // Mirrors `db::materials::save_material_on_conn` so the graph edge schema
    // stays consistent across imported and generated materials.
    for (i, word_id) in word_ids.iter().enumerate() {
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
    Ok(())
}

async fn refresh_unknown_count(conn: &Connection, material_id: i64) -> DbResult<()> {
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
    Ok(())
}

fn story_from_parts(
    material_id: i64,
    tiptap_json: String,
    raw_text: String,
    payload: String,
) -> DbResult<StoryMaterial> {
    let value: Value = serde_json::from_str(&payload)
        .map_err(|e| format!("story material {material_id} mcq_payload parse: {e}"))?;
    let blanks_value = value
        .get("blanks")
        .cloned()
        .ok_or_else(|| format!("story material {material_id} mcq_payload missing blanks"))?;
    let blanks: Vec<ClozeBlank> = serde_json::from_value(blanks_value)
        .map_err(|e| format!("story material {material_id} blanks parse: {e}"))?;
    let story_text = extract_tiptap_text(&tiptap_json)
        .filter(|text| text.contains("{{"))
        .unwrap_or_else(|| placeholderize_raw_blanks(&raw_text));

    Ok(StoryMaterial {
        material_id,
        story_text,
        tiptap_json,
        blanks,
    })
}

fn extract_tiptap_text(tiptap_json: &str) -> Option<String> {
    fn walk(node: &Value, out: &mut String) {
        if let Some(text) = node.get("text").and_then(Value::as_str) {
            out.push_str(text);
        }
        if let Some(children) = node.get("content").and_then(Value::as_array) {
            for child in children {
                walk(child, out);
            }
        }
    }

    let value: Value = serde_json::from_str(tiptap_json).ok()?;
    let mut out = String::new();
    walk(&value, &mut out);
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

fn placeholderize_raw_blanks(story_text: &str) -> String {
    let mut out = String::with_capacity(story_text.len() + 8);
    let mut counter: usize = 0;
    let mut chars = story_text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '_' {
            let mut run = 1;
            while let Some(&next) = chars.peek() {
                if next == '_' {
                    run += 1;
                    chars.next();
                } else {
                    break;
                }
            }
            if run >= 4 {
                counter += 1;
                out.push_str(&format!("{{{{{counter}}}}}"));
            } else {
                for _ in 0..run {
                    out.push('_');
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

fn blank_count(payload: Option<&str>) -> usize {
    payload
        .and_then(|p| serde_json::from_str::<Value>(p).ok())
        .and_then(|v| v.get("blanks").and_then(Value::as_array).map(Vec::len))
        .unwrap_or(0)
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
            .query(
                "SELECT id FROM words WHERE lemma = ?1",
                turso::params![lemma],
            )
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

    #[tokio::test]
    async fn load_story_round_trips_tiptap_text_and_mcq_payload() {
        let conn = setup_db().await;
        let alpha = seed_word(&conn, "alpha").await;
        let blanks = vec![ClozeBlank {
            index: 0,
            target_word_id: alpha,
            options: vec![
                "alpha".into(),
                "alike".into(),
                "alley".into(),
                "alpine".into(),
            ],
            correct_index: 0,
        }];
        let payload = serde_json::json!({ "blanks": blanks });
        let tiptap = serde_json::json!({
            "type": "doc",
            "content": [{
                "type": "paragraph",
                "content": [{ "type": "text", "text": "He said {{1}}." }]
            }]
        })
        .to_string();
        let input = StoryInsertInput {
            title: "Daily Story",
            story_text_placeholders: "He said {{1}}.",
            raw_text: "He said ____.",
            tiptap_json: &tiptap,
            mcq_payload: &payload,
            word_ids: &[alpha],
            total_tokens: 3,
            unique_tokens: 3,
            blanks: &blanks,
        };

        let inserted = insert_story_on_conn(&conn, &input).await.unwrap();
        let loaded = load_story_on_conn(&conn, inserted.material_id)
            .await
            .unwrap()
            .unwrap();

        assert_eq!(loaded.material_id, inserted.material_id);
        assert_eq!(loaded.story_text, "He said {{1}}.");
        assert_eq!(loaded.blanks.len(), 1);
        assert_eq!(loaded.blanks[0].target_word_id, alpha);
    }

    #[tokio::test]
    async fn list_story_history_returns_newest_ai_stories_only() {
        let conn = setup_db().await;
        let alpha = seed_word(&conn, "alpha").await;
        let blanks = vec![ClozeBlank {
            index: 0,
            target_word_id: alpha,
            options: vec![
                "alpha".into(),
                "alike".into(),
                "alley".into(),
                "alpine".into(),
            ],
            correct_index: 0,
        }];
        let payload = serde_json::json!({ "blanks": blanks });

        for title in ["First Story", "Second Story"] {
            let input = StoryInsertInput {
                title,
                story_text_placeholders: "He said {{1}}.",
                raw_text: "He said ____.",
                tiptap_json: "{\"type\":\"doc\",\"content\":[]}",
                mcq_payload: &payload,
                word_ids: &[alpha],
                total_tokens: 3,
                unique_tokens: 3,
                blanks: &blanks,
            };
            insert_story_on_conn(&conn, &input).await.unwrap();
        }
        conn.execute(
            "INSERT INTO materials \
               (title, source_kind, tiptap_json, raw_text, total_tokens, unique_tokens, \
                unknown_count_at_import, created_at) \
             VALUES ('Paste', 'paste', '{}', 'plain', 1, 1, 0, ?1)",
            turso::params![now_ms()],
        )
        .await
        .unwrap();

        let history = list_story_history_on_conn(&conn).await.unwrap();

        assert_eq!(history.len(), 2);
        assert_eq!(history[0].title, "Second Story");
        assert_eq!(history[0].blank_count, 1);
        assert_eq!(history[1].title, "First Story");
    }

    #[tokio::test]
    async fn replace_story_overwrites_existing_material_and_edges() {
        let conn = setup_db().await;
        let alpha = seed_word(&conn, "alpha").await;
        let bravo = seed_word(&conn, "bravo").await;
        let first_blanks = vec![ClozeBlank {
            index: 0,
            target_word_id: alpha,
            options: vec![
                "alpha".into(),
                "alike".into(),
                "alley".into(),
                "alpine".into(),
            ],
            correct_index: 0,
        }];
        let first_payload = serde_json::json!({ "blanks": first_blanks });
        let first = StoryInsertInput {
            title: "First Story",
            story_text_placeholders: "First {{1}}.",
            raw_text: "First ____.",
            tiptap_json: "{\"type\":\"doc\",\"content\":[{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"First {{1}}.\"}]}]}",
            mcq_payload: &first_payload,
            word_ids: &[alpha],
            total_tokens: 2,
            unique_tokens: 2,
            blanks: &first_blanks,
        };
        let inserted = insert_story_on_conn(&conn, &first).await.unwrap();

        let next_blanks = vec![ClozeBlank {
            index: 0,
            target_word_id: bravo,
            options: vec![
                "bravo".into(),
                "brave".into(),
                "broad".into(),
                "brand".into(),
            ],
            correct_index: 0,
        }];
        let next_payload = serde_json::json!({ "blanks": next_blanks });
        let next_tiptap = serde_json::json!({
            "type": "doc",
            "content": [{
                "type": "paragraph",
                "content": [{ "type": "text", "text": "Next {{1}}." }]
            }]
        })
        .to_string();
        let next = StoryInsertInput {
            title: "Next Story",
            story_text_placeholders: "Next {{1}}.",
            raw_text: "Next ____.",
            tiptap_json: &next_tiptap,
            mcq_payload: &next_payload,
            word_ids: &[bravo],
            total_tokens: 2,
            unique_tokens: 2,
            blanks: &next_blanks,
        };

        let replaced = replace_story_on_conn(&conn, inserted.material_id, &next)
            .await
            .unwrap();
        let loaded = load_story_on_conn(&conn, inserted.material_id)
            .await
            .unwrap()
            .unwrap();
        let word_ids = story_word_ids_on_conn(&conn, inserted.material_id)
            .await
            .unwrap();

        assert_eq!(replaced.material_id, inserted.material_id);
        assert_eq!(loaded.story_text, "Next {{1}}.");
        assert_eq!(loaded.blanks[0].target_word_id, bravo);
        assert_eq!(word_ids, vec![bravo]);
    }

    #[tokio::test]
    async fn delete_story_removes_material_and_edges() {
        let conn = setup_db().await;
        let alpha = seed_word(&conn, "alpha").await;
        let blanks = vec![ClozeBlank {
            index: 0,
            target_word_id: alpha,
            options: vec![
                "alpha".into(),
                "alike".into(),
                "alley".into(),
                "alpine".into(),
            ],
            correct_index: 0,
        }];
        let payload = serde_json::json!({ "blanks": blanks });
        let input = StoryInsertInput {
            title: "Delete Me",
            story_text_placeholders: "Delete {{1}}.",
            raw_text: "Delete ____.",
            tiptap_json: "{\"type\":\"doc\",\"content\":[]}",
            mcq_payload: &payload,
            word_ids: &[alpha],
            total_tokens: 2,
            unique_tokens: 2,
            blanks: &blanks,
        };

        let inserted = insert_story_on_conn(&conn, &input).await.unwrap();
        let deleted = delete_story_on_conn(&conn, inserted.material_id)
            .await
            .unwrap();
        let loaded = load_story_on_conn(&conn, inserted.material_id)
            .await
            .unwrap();
        let word_ids = story_word_ids_on_conn(&conn, inserted.material_id)
            .await
            .unwrap();

        assert!(deleted);
        assert!(loaded.is_none());
        assert!(word_ids.is_empty());
    }
}
