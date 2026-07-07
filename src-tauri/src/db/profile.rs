//! Per-word learning-profile aggregation.
//!
//! `word_profile` is the "recall everything about this word" read model: one
//! IPC call returns the words row, the SRS schedule + recent review log, the
//! dictionary lookup history, usage telemetry, and every material (document /
//! AI story / writing submission) the word appears in. Powers the
//! WordProfileDrawer so any surface can pull a word's full learning trail.
//!
//! Follows the split-surface pattern of the sibling modules: `*_on_conn` for
//! tests, thin singleton wrapper for the Tauri command.

use serde::Serialize;
use turso::Connection;

use super::materials::{materials_for_word_on_conn, MaterialForWord};
use super::{get_connection, DbResult};

/// Live FSRS schedule for a word, if it has ever been added to SRS.
#[derive(Debug, Clone, Serialize)]
pub struct SrsSnapshot {
    pub stability: f64,
    pub difficulty: f64,
    pub scheduled_days: i64,
    pub reps: i64,
    pub lapses: i64,
    pub last_review: Option<i64>,
    pub due: i64,
}

/// One historical review, newest first in `WordProfile::recent_reviews`.
#[derive(Debug, Clone, Serialize)]
pub struct ReviewLogEntry {
    pub rating: i64,
    pub reviewed_at: i64,
    pub prev_stability: Option<f64>,
    pub new_stability: Option<f64>,
}

/// Dictionary lookup trail for the lemma (from `lookup_history`).
#[derive(Debug, Clone, Serialize)]
pub struct LookupSummary {
    pub lookup_count: i64,
    pub first_looked_up_at: i64,
    pub last_looked_up_at: i64,
}

/// Everything WordBrain knows about one lemma, in a single payload.
#[derive(Debug, Clone, Serialize)]
pub struct WordProfile {
    pub word_id: i64,
    pub lemma: String,
    pub state: String,
    pub state_source: Option<String>,
    pub freq_rank: Option<i64>,
    pub exposure_count: i64,
    pub usage_count: i64,
    /// Derived practice level, `MIN(10, usage_count)` — mirrors `db::usage`.
    pub level: i64,
    pub first_seen_at: Option<i64>,
    pub marked_known_at: Option<i64>,
    pub user_note: Option<String>,
    pub srs: Option<SrsSnapshot>,
    /// Last 10 reviews, newest first.
    pub recent_reviews: Vec<ReviewLogEntry>,
    pub lookup: Option<LookupSummary>,
    /// Count of `word_usage_log` events per practice surface.
    pub story_uses: i64,
    pub writing_uses: i64,
    /// Every material containing the word (docs, stories, writing submissions),
    /// newest first, with `source_kind` so the UI can group + route clicks.
    pub materials: Vec<MaterialForWord>,
}

const RECENT_REVIEWS_LIMIT: i64 = 10;

/// Aggregate the full learning profile for `lemma`. Returns `Ok(None)` when
/// the lemma has no `words` row yet (never imported, marked, or scheduled).
pub async fn word_profile_on_conn(
    conn: &Connection,
    raw_lemma: &str,
) -> DbResult<Option<WordProfile>> {
    let lemma = raw_lemma.trim().to_lowercase();
    if lemma.is_empty() {
        return Ok(None);
    }

    // 1. Words row — the anchor. Everything else keys off word_id.
    let mut rows = conn
        .query(
            "SELECT id, lemma, state, state_source, freq_rank, exposure_count, \
                    usage_count, first_seen_at, marked_known_at, user_note \
               FROM words WHERE lemma = ?1 COLLATE NOCASE LIMIT 1",
            turso::params![lemma.as_str()],
        )
        .await?;
    let Some(row) = rows.next().await? else {
        return Ok(None);
    };
    let word_id: i64 = row.get(0)?;
    let canonical_lemma: String = row.get(1)?;
    let state: String = row.get(2)?;
    let state_source = nullable_string(&row, 3)?;
    let freq_rank = nullable_i64(&row, 4)?;
    let exposure_count: i64 = row.get(5)?;
    let usage_count: i64 = row.get(6)?;
    let first_seen_at = nullable_i64(&row, 7)?;
    let marked_known_at = nullable_i64(&row, 8)?;
    let user_note = nullable_string(&row, 9)?;
    drop(rows);

    // 2. SRS schedule snapshot.
    let mut rows = conn
        .query(
            "SELECT stability, difficulty, scheduled_days, reps, lapses, \
                    last_review, due \
               FROM srs_schedule WHERE word_id = ?1",
            turso::params![word_id],
        )
        .await?;
    let srs = if let Some(row) = rows.next().await? {
        Some(SrsSnapshot {
            stability: row.get::<f64>(0)?,
            difficulty: row.get::<f64>(1)?,
            scheduled_days: row.get::<i64>(2)?,
            reps: row.get::<i64>(3)?,
            lapses: row.get::<i64>(4)?,
            last_review: nullable_i64(&row, 5)?,
            due: row.get::<i64>(6)?,
        })
    } else {
        None
    };
    drop(rows);

    // 3. Recent review log, newest first.
    let mut rows = conn
        .query(
            "SELECT rating, reviewed_at, prev_stability, new_stability \
               FROM srs_review_log \
              WHERE word_id = ?1 \
              ORDER BY reviewed_at DESC, id DESC \
              LIMIT ?2",
            turso::params![word_id, RECENT_REVIEWS_LIMIT],
        )
        .await?;
    let mut recent_reviews = Vec::new();
    while let Some(row) = rows.next().await? {
        recent_reviews.push(ReviewLogEntry {
            rating: row.get::<i64>(0)?,
            reviewed_at: row.get::<i64>(1)?,
            prev_stability: nullable_f64(&row, 2)?,
            new_stability: nullable_f64(&row, 3)?,
        });
    }

    // 4. Dictionary lookup trail.
    let mut rows = conn
        .query(
            "SELECT lookup_count, first_looked_up_at, last_looked_up_at \
               FROM lookup_history WHERE lemma = ?1",
            turso::params![lemma.as_str()],
        )
        .await?;
    let lookup = if let Some(row) = rows.next().await? {
        Some(LookupSummary {
            lookup_count: row.get::<i64>(0)?,
            first_looked_up_at: row.get::<i64>(1)?,
            last_looked_up_at: row.get::<i64>(2)?,
        })
    } else {
        None
    };
    drop(rows);

    // 5. Usage telemetry per practice surface.
    let mut story_uses = 0i64;
    let mut writing_uses = 0i64;
    let mut rows = conn
        .query(
            "SELECT surface, COUNT(*) FROM word_usage_log \
              WHERE word_id = ?1 GROUP BY surface",
            turso::params![word_id],
        )
        .await?;
    while let Some(row) = rows.next().await? {
        let surface: String = row.get(0)?;
        let count: i64 = row.get(1)?;
        match surface.as_str() {
            "story_review" => story_uses = count,
            "writing_train" => writing_uses = count,
            _ => {}
        }
    }

    // 6. Every material containing the word (already newest-first).
    let materials = materials_for_word_on_conn(conn, &canonical_lemma).await?;

    Ok(Some(WordProfile {
        word_id,
        lemma: canonical_lemma,
        state,
        state_source,
        freq_rank,
        exposure_count,
        usage_count,
        level: usage_count.clamp(0, 10),
        first_seen_at,
        marked_known_at,
        user_note,
        srs,
        recent_reviews,
        lookup,
        story_uses,
        writing_uses,
        materials,
    }))
}

pub async fn word_profile(lemma: &str) -> DbResult<Option<WordProfile>> {
    let conn = get_connection()?.lock().await;
    word_profile_on_conn(&conn, lemma).await
}

fn nullable_i64(row: &turso::Row, col: usize) -> DbResult<Option<i64>> {
    match row.get_value(col)? {
        turso::Value::Null => Ok(None),
        turso::Value::Integer(i) => Ok(Some(i)),
        _ => Err("expected nullable integer column".into()),
    }
}

fn nullable_f64(row: &turso::Row, col: usize) -> DbResult<Option<f64>> {
    match row.get_value(col)? {
        turso::Value::Null => Ok(None),
        turso::Value::Real(f) => Ok(Some(f)),
        turso::Value::Integer(i) => Ok(Some(i as f64)),
        _ => Err("expected nullable real column".into()),
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
    use crate::db::lookup_history::record_lookup_on_conn;
    use crate::db::materials::{save_material_on_conn, SaveMaterialInput, TokenEdge};
    use crate::db::srs::{add_to_srs_on_conn, apply_rating_on_conn, SchedulingUpdate};
    use crate::db::usage::{register_word_use_on_conn, SURFACE_STORY_REVIEW};
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

    fn material_input(title: &str, source_kind: &str, lemmas: &[&str]) -> SaveMaterialInput {
        SaveMaterialInput {
            title: title.to_string(),
            source_kind: source_kind.to_string(),
            origin_path: None,
            tiptap_json: "{}".to_string(),
            raw_text: lemmas.join(" "),
            total_tokens: lemmas.len() as i64,
            unique_tokens: lemmas.len() as i64,
            tokens: lemmas
                .iter()
                .enumerate()
                .map(|(i, l)| TokenEdge {
                    lemma: (*l).to_string(),
                    occurrence_count: 1,
                    first_position: i as i64,
                    sentence_preview: Some(format!("A sentence with {l}.")),
                })
                .collect(),
            parent_material_id: None,
            chapter_index: None,
        }
    }

    #[tokio::test]
    async fn profile_missing_word_returns_none() {
        let conn = setup_db().await;
        let out = word_profile_on_conn(&conn, "ghost").await.unwrap();
        assert!(out.is_none());
        let out = word_profile_on_conn(&conn, "   ").await.unwrap();
        assert!(out.is_none());
    }

    #[tokio::test]
    async fn profile_aggregates_all_learning_surfaces() {
        let conn = setup_db().await;

        // Encounter: the word arrives via two documents and one AI story.
        save_material_on_conn(&conn, &material_input("Doc A", "paste", &["serendipity", "walk"]))
            .await
            .unwrap();
        save_material_on_conn(&conn, &material_input("Doc B", "file", &["serendipity"]))
            .await
            .unwrap();
        save_material_on_conn(&conn, &material_input("Story 1", "ai_story", &["serendipity"]))
            .await
            .unwrap();

        // Learn: two dictionary lookups.
        record_lookup_on_conn(&conn, "serendipity").await.unwrap();
        record_lookup_on_conn(&conn, "Serendipity").await.unwrap();

        // Review: schedule + one Good rating.
        let now = crate::db::now_ms();
        add_to_srs_on_conn(&conn, "serendipity", now).await.unwrap();
        let update = SchedulingUpdate {
            stability: 2.5,
            difficulty: 5.0,
            elapsed_days: 0,
            scheduled_days: 2,
            due: now + 2 * 86_400_000,
        };
        apply_rating_on_conn(&conn, "serendipity", 3, &update, now, 3)
            .await
            .unwrap();

        let profile = word_profile_on_conn(&conn, "  SERENDIPITY ")
            .await
            .unwrap()
            .expect("profile exists");

        // Apply: one story-review usage event.
        register_word_use_on_conn(&conn, profile.word_id, SURFACE_STORY_REVIEW)
            .await
            .unwrap();
        let profile = word_profile_on_conn(&conn, "serendipity")
            .await
            .unwrap()
            .expect("profile exists");

        assert_eq!(profile.lemma, "serendipity");
        assert_eq!(profile.state, "learning", "add_to_srs flips unknown → learning");
        assert_eq!(profile.usage_count, 1);
        assert_eq!(profile.level, 1);
        assert_eq!(profile.story_uses, 1);
        assert_eq!(profile.writing_uses, 0);

        let srs = profile.srs.expect("srs snapshot present");
        assert_eq!(srs.reps, 1);
        assert_eq!(srs.lapses, 0);
        assert!((srs.stability - 2.5).abs() < f64::EPSILON);

        assert_eq!(profile.recent_reviews.len(), 1);
        assert_eq!(profile.recent_reviews[0].rating, 3);
        assert_eq!(profile.recent_reviews[0].new_stability, Some(2.5));

        let lookup = profile.lookup.expect("lookup summary present");
        assert_eq!(lookup.lookup_count, 2);

        // Three materials, newest first, each tagged with its source_kind so
        // the drawer can split docs from practice artefacts.
        assert_eq!(profile.materials.len(), 3);
        let kinds: Vec<&str> = profile
            .materials
            .iter()
            .map(|m| m.source_kind.as_str())
            .collect();
        assert!(kinds.contains(&"paste"));
        assert!(kinds.contains(&"file"));
        assert!(kinds.contains(&"ai_story"));
        for m in &profile.materials {
            assert_eq!(
                m.sentence_preview.as_deref(),
                Some("A sentence with serendipity.")
            );
        }
    }

    #[tokio::test]
    async fn profile_without_srs_or_lookup_is_sparse_but_present() {
        let conn = setup_db().await;
        save_material_on_conn(&conn, &material_input("Doc", "paste", &["walk"]))
            .await
            .unwrap();

        let profile = word_profile_on_conn(&conn, "walk")
            .await
            .unwrap()
            .expect("profile exists");
        assert!(profile.srs.is_none());
        assert!(profile.lookup.is_none());
        assert!(profile.recent_reviews.is_empty());
        assert_eq!(profile.story_uses, 0);
        assert_eq!(profile.materials.len(), 1);
        assert_eq!(profile.state, "unknown");
    }
}
