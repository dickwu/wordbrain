//! Whole-loop learning statistics for the Learning hub.
//!
//! One `learning_stats` call feeds the hub dashboard: the vocabulary funnel
//! (unknown → learning → known), SRS load (due now / scheduled), a per-day
//! review-activity strip, and totals for the surrounding surfaces (lookups,
//! documents, stories, writing submissions).
//!
//! Day bucketing is done in Rust against a caller-supplied timezone offset so
//! "today" matches the user's wall clock, not UTC.

use serde::Serialize;
use turso::Connection;

use super::{get_connection, now_ms, DbResult};

const MS_PER_DAY: i64 = 86_400_000;
const NEW_WORDS_WINDOW_DAYS: i64 = 7;

/// Review count for one local-time day. `day_start_ms` is the UTC timestamp
/// of that local midnight, so the frontend can format labels directly.
#[derive(Debug, Clone, Serialize)]
pub struct DayReviews {
    pub day_start_ms: i64,
    pub reviews: i64,
}

/// Known-word count per `state_source` graduation path.
#[derive(Debug, Clone, Serialize)]
pub struct SourceCount {
    pub source: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct LearningStats {
    // Vocabulary funnel (proper names excluded, like the library counts).
    pub unknown_count: i64,
    pub learning_count: i64,
    pub known_count: i64,
    pub known_by_source: Vec<SourceCount>,
    // SRS load.
    pub due_now: i64,
    pub scheduled_total: i64,
    // Activity strip, oldest → newest, exactly `days` entries.
    pub reviews_by_day: Vec<DayReviews>,
    pub reviews_today: i64,
    /// Words first met (any surface) in the last 7 days. Seeded rows have
    /// `first_seen_at = NULL` so the install-time bulk import never counts.
    pub new_words_last_7d: i64,
    // Surrounding-surface totals.
    pub lookups_total: i64,
    pub documents_total: i64,
    pub stories_total: i64,
    pub writing_total: i64,
}

/// Compute the full stats payload.
///
/// * `days` — length of the review-activity strip (clamped to 1..=90).
/// * `tz_offset_minutes` — minutes to ADD to UTC to get local time (JS
///   `-new Date().getTimezoneOffset()`).
/// * `now` — injected for tests; `now_ms()` in production.
pub async fn learning_stats_on_conn(
    conn: &Connection,
    days: u32,
    tz_offset_minutes: i64,
    now: i64,
) -> DbResult<LearningStats> {
    let days = days.clamp(1, 90) as i64;
    let tz_ms = tz_offset_minutes * 60_000;

    // 1. Vocabulary funnel by state.
    let mut unknown_count = 0i64;
    let mut learning_count = 0i64;
    let mut known_count = 0i64;
    let mut rows = conn
        .query(
            "SELECT w.state, COUNT(*) FROM words w \
              WHERE NOT EXISTS (SELECT 1 FROM known_names kn WHERE kn.name = w.lemma) \
              GROUP BY w.state",
            (),
        )
        .await?;
    while let Some(row) = rows.next().await? {
        let state: String = row.get(0)?;
        let count: i64 = row.get(1)?;
        match state.as_str() {
            "unknown" => unknown_count = count,
            "learning" => learning_count = count,
            "known" => known_count = count,
            _ => {}
        }
    }
    drop(rows);

    // 2. Known-word breakdown by graduation path.
    let mut known_by_source = Vec::new();
    let mut rows = conn
        .query(
            "SELECT COALESCE(state_source, 'manual'), COUNT(*) \
               FROM words WHERE state = 'known' \
              GROUP BY COALESCE(state_source, 'manual') \
              ORDER BY COUNT(*) DESC",
            (),
        )
        .await?;
    while let Some(row) = rows.next().await? {
        known_by_source.push(SourceCount {
            source: row.get::<String>(0)?,
            count: row.get::<i64>(1)?,
        });
    }
    drop(rows);

    // 3. SRS load.
    let due_now = scalar_i64(
        conn,
        "SELECT COUNT(*) FROM srs_schedule WHERE due <= ?1",
        turso::params![now],
    )
    .await?;
    let scheduled_total = scalar_i64(conn, "SELECT COUNT(*) FROM srs_schedule", ()).await?;

    // 4. Review activity strip. Bucket by local day: index = floor((t + tz) / day).
    let today_idx = (now + tz_ms).div_euclid(MS_PER_DAY);
    let first_idx = today_idx - (days - 1);
    let window_start_utc = first_idx * MS_PER_DAY - tz_ms;
    let mut buckets = vec![0i64; days as usize];
    let mut rows = conn
        .query(
            "SELECT reviewed_at FROM srs_review_log WHERE reviewed_at >= ?1",
            turso::params![window_start_utc],
        )
        .await?;
    while let Some(row) = rows.next().await? {
        let reviewed_at: i64 = row.get(0)?;
        let idx = (reviewed_at + tz_ms).div_euclid(MS_PER_DAY) - first_idx;
        if (0..days).contains(&idx) {
            buckets[idx as usize] += 1;
        }
    }
    drop(rows);
    let reviews_by_day: Vec<DayReviews> = buckets
        .into_iter()
        .enumerate()
        .map(|(i, reviews)| DayReviews {
            day_start_ms: (first_idx + i as i64) * MS_PER_DAY - tz_ms,
            reviews,
        })
        .collect();
    let reviews_today = reviews_by_day.last().map(|d| d.reviews).unwrap_or(0);

    // 5. Words met in the last 7 days.
    let new_words_last_7d = scalar_i64(
        conn,
        "SELECT COUNT(*) FROM words \
          WHERE first_seen_at IS NOT NULL AND first_seen_at >= ?1",
        turso::params![now - NEW_WORDS_WINDOW_DAYS * MS_PER_DAY],
    )
    .await?;

    // 6. Surrounding surfaces.
    let lookups_total = scalar_i64(
        conn,
        "SELECT COALESCE(SUM(lookup_count), 0) FROM lookup_history",
        (),
    )
    .await?;
    let documents_total = scalar_i64(
        conn,
        "SELECT COUNT(*) FROM materials \
          WHERE parent_material_id IS NULL \
            AND source_kind NOT IN ('ai_story', 'writing_submission')",
        (),
    )
    .await?;
    let stories_total = scalar_i64(
        conn,
        "SELECT COUNT(*) FROM materials WHERE source_kind = 'ai_story'",
        (),
    )
    .await?;
    let writing_total = scalar_i64(
        conn,
        "SELECT COUNT(*) FROM materials WHERE source_kind = 'writing_submission'",
        (),
    )
    .await?;

    Ok(LearningStats {
        unknown_count,
        learning_count,
        known_count,
        known_by_source,
        due_now,
        scheduled_total,
        reviews_by_day,
        reviews_today,
        new_words_last_7d,
        lookups_total,
        documents_total,
        stories_total,
        writing_total,
    })
}

pub async fn learning_stats(days: u32, tz_offset_minutes: i64) -> DbResult<LearningStats> {
    let conn = get_connection()?.lock().await;
    learning_stats_on_conn(&conn, days, tz_offset_minutes, now_ms()).await
}

async fn scalar_i64<P: turso::IntoParams>(
    conn: &Connection,
    sql: &str,
    params: P,
) -> DbResult<i64> {
    let mut rows = conn.query(sql, params).await?;
    if let Some(row) = rows.next().await? {
        Ok(row.get::<i64>(0)?)
    } else {
        Ok(0)
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

    async fn seed_word(conn: &Connection, lemma: &str, state: &str, first_seen_at: Option<i64>) {
        conn.execute(
            "INSERT INTO words (lemma, state, state_source, first_seen_at, created_at, updated_at) \
             VALUES (?1, ?2, 'test', ?3, 0, 0)",
            turso::params![lemma, state, first_seen_at],
        )
        .await
        .expect("seed word");
    }

    async fn log_review(conn: &Connection, word_id: i64, reviewed_at: i64) {
        conn.execute(
            "INSERT INTO srs_review_log (word_id, rating, reviewed_at) VALUES (?1, 3, ?2)",
            turso::params![word_id, reviewed_at],
        )
        .await
        .expect("log review");
    }

    #[tokio::test]
    async fn stats_empty_db_is_all_zeroes_with_full_strip() {
        let conn = setup_db().await;
        let now = 10 * MS_PER_DAY + 5_000;
        let stats = learning_stats_on_conn(&conn, 14, 0, now).await.unwrap();
        assert_eq!(stats.unknown_count, 0);
        assert_eq!(stats.learning_count, 0);
        assert_eq!(stats.known_count, 0);
        assert_eq!(stats.due_now, 0);
        assert_eq!(stats.scheduled_total, 0);
        assert_eq!(stats.reviews_by_day.len(), 14);
        assert!(stats.reviews_by_day.iter().all(|d| d.reviews == 0));
        assert_eq!(stats.reviews_today, 0);
        assert_eq!(stats.lookups_total, 0);
    }

    #[tokio::test]
    async fn stats_counts_funnel_and_excludes_known_names() {
        let conn = setup_db().await;
        seed_word(&conn, "alpha", "unknown", None).await;
        seed_word(&conn, "bravo", "learning", None).await;
        seed_word(&conn, "charlie", "known", None).await;
        seed_word(&conn, "delta", "known", None).await;
        // A proper name that leaked into `words` must not count.
        seed_word(&conn, "london", "unknown", None).await;
        conn.execute(
            "INSERT INTO known_names (name, source, created_at, updated_at) \
             VALUES ('london', 'test', 0, 0)",
            (),
        )
        .await
        .unwrap();

        let stats = learning_stats_on_conn(&conn, 7, 0, MS_PER_DAY).await.unwrap();
        assert_eq!(stats.unknown_count, 1, "london excluded via known_names");
        assert_eq!(stats.learning_count, 1);
        assert_eq!(stats.known_count, 2);
        assert_eq!(stats.known_by_source.len(), 1);
        assert_eq!(stats.known_by_source[0].source, "test");
        assert_eq!(stats.known_by_source[0].count, 2);
    }

    #[tokio::test]
    async fn stats_buckets_reviews_by_local_day() {
        let conn = setup_db().await;
        seed_word(&conn, "alpha", "learning", None).await;

        // now = middle of local day 100 with a +8h offset (480 min).
        let tz_min = 480i64;
        let tz_ms = tz_min * 60_000;
        let day100_local_start_utc = 100 * MS_PER_DAY - tz_ms;
        let now = day100_local_start_utc + MS_PER_DAY / 2;

        // Two reviews today, one yesterday, one outside the 3-day strip.
        log_review(&conn, 1, day100_local_start_utc + 1_000).await;
        log_review(&conn, 1, day100_local_start_utc + 2_000).await;
        log_review(&conn, 1, day100_local_start_utc - MS_PER_DAY + 1_000).await;
        log_review(&conn, 1, day100_local_start_utc - 5 * MS_PER_DAY).await;

        let stats = learning_stats_on_conn(&conn, 3, tz_min, now).await.unwrap();
        assert_eq!(stats.reviews_by_day.len(), 3);
        let counts: Vec<i64> = stats.reviews_by_day.iter().map(|d| d.reviews).collect();
        assert_eq!(counts, vec![0, 1, 2], "oldest → newest");
        assert_eq!(stats.reviews_today, 2);
        // Bucket starts land on local midnights (UTC-shifted).
        assert_eq!(
            stats.reviews_by_day[2].day_start_ms,
            day100_local_start_utc
        );
    }

    #[tokio::test]
    async fn stats_new_words_window_ignores_null_first_seen() {
        let conn = setup_db().await;
        let now = 30 * MS_PER_DAY;
        seed_word(&conn, "fresh", "unknown", Some(now - MS_PER_DAY)).await;
        seed_word(&conn, "stale", "unknown", Some(now - 20 * MS_PER_DAY)).await;
        // Seeded-known style row: first_seen_at NULL — never counted.
        seed_word(&conn, "seeded", "known", None).await;

        let stats = learning_stats_on_conn(&conn, 7, 0, now).await.unwrap();
        assert_eq!(stats.new_words_last_7d, 1);
    }

    #[tokio::test]
    async fn stats_counts_materials_by_kind() {
        let conn = setup_db().await;
        for (title, kind, parent) in [
            ("Doc", "paste", None::<i64>),
            ("Book", "epub", None),
            ("Chapter", "epub_chapter", Some(2)),
            ("Story", "ai_story", None),
            ("Writing", "writing_submission", None),
        ] {
            conn.execute(
                "INSERT INTO materials \
                   (title, source_kind, tiptap_json, raw_text, total_tokens, \
                    unique_tokens, unknown_count_at_import, parent_material_id, created_at) \
                 VALUES (?1, ?2, '{}', '', 0, 0, 0, ?3, 0)",
                turso::params![title, kind, parent],
            )
            .await
            .unwrap();
        }

        let stats = learning_stats_on_conn(&conn, 7, 0, MS_PER_DAY).await.unwrap();
        assert_eq!(stats.documents_total, 2, "doc + book roots; chapter is a child");
        assert_eq!(stats.stories_total, 1);
        assert_eq!(stats.writing_total, 1);
    }
}
