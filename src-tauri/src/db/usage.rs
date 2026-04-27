//! Learning-loop telemetry helpers.
//!
//! `usage_count` on the words row + the `word_usage_log` audit table form the
//! "Level (0–10)" surface defined in `.omc/specs/deep-interview-wordbrain-finish-learning-loop.md`.
//! Every Story / Writing surface "use" event flows through
//! [`register_word_use_on_conn`] (atomic `BEGIN IMMEDIATE … COMMIT`) and the
//! Story / Writing sidebars pull their candidate set from
//! [`recent_practice_words_on_conn`].

use turso::{Connection, Value};

use super::{get_connection, DbResult};

/// Allowed `surface` values for [`register_word_use_on_conn`]. Mirrors the
/// CHECK constraint on `word_usage_log.surface`.
pub const SURFACE_STORY_REVIEW: &str = "story_review";
pub const SURFACE_WRITING_TRAIN: &str = "writing_train";

/// One row of the recent-practice sidebar feed. Sort key is `usage_count ASC,
/// first_seen_at DESC`; `level` is derived as `MIN(10, usage_count)` so the
/// frontend never has to compute it.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentWord {
    pub id: i64,
    pub lemma: String,
    pub usage_count: i64,
    pub level: i64,
    pub first_seen_at: Option<i64>,
    pub state: String,
}

/// Atomically `+1` the lemma's `usage_count` and append a row to
/// `word_usage_log`. Both writes happen inside one `BEGIN IMMEDIATE` so a
/// second concurrent caller cannot read-modify-write past us. Returns the new
/// counter value (post-increment).
///
/// `surface` MUST be one of [`SURFACE_STORY_REVIEW`] / [`SURFACE_WRITING_TRAIN`].
pub async fn register_word_use_on_conn(
    conn: &Connection,
    word_id: i64,
    surface: &str,
) -> DbResult<u32> {
    if surface != SURFACE_STORY_REVIEW && surface != SURFACE_WRITING_TRAIN {
        return Err(format!("invalid usage surface: {surface}").into());
    }

    conn.execute("BEGIN IMMEDIATE;", ()).await?;
    let result: DbResult<u32> = async {
        // 1. Bump the cumulative counter on the words row.
        conn.execute(
            "UPDATE words SET usage_count = usage_count + 1, updated_at = ?1 \
              WHERE id = ?2",
            turso::params![super::now_ms(), word_id],
        )
        .await?;

        // 2. Confirm the row exists + capture the new counter atomically with
        //    the bump (we are inside a write transaction).
        let mut rows = conn
            .query(
                "SELECT usage_count FROM words WHERE id = ?1",
                turso::params![word_id],
            )
            .await?;
        let new_count: i64 = match rows.next().await? {
            Some(r) => r.get(0)?,
            None => return Err(format!("word_id {word_id} not found").into()),
        };

        // 3. Append the audit-log entry.
        conn.execute(
            "INSERT INTO word_usage_log (word_id, surface) VALUES (?1, ?2)",
            turso::params![word_id, surface],
        )
        .await?;

        Ok(new_count.max(0) as u32)
    }
    .await;

    match result {
        Ok(n) => {
            conn.execute("COMMIT;", ()).await?;
            Ok(n)
        }
        Err(e) => {
            let _ = conn.execute("ROLLBACK;", ()).await;
            Err(e)
        }
    }
}

pub async fn register_word_use(word_id: i64, surface: &str) -> DbResult<u32> {
    let conn = get_connection()?.lock().await;
    register_word_use_on_conn(&conn, word_id, surface).await
}

/// Return up to `limit` candidate words for the Story / Writing sidebars.
///
/// SQL contract (mirrors §Constraints "Recent-words selection" in the spec):
/// ```sql
/// SELECT … FROM words
/// WHERE state IN ('learning','unknown')
///   AND first_seen_at >= <now-window_days>
/// ORDER BY usage_count ASC, first_seen_at DESC
/// LIMIT ?
/// ```
/// The composite index `idx_words_usage_count_first_seen` makes the
/// `ORDER BY` resolvable without a sort buffer.
///
/// `first_seen_at` is stored as ms-since-epoch (see `db::now_ms`) so the
/// cutoff is computed in Rust rather than SQL — that keeps the query
/// independent of SQLite's `datetime()` semantics + the rest of the
/// codebase's INTEGER-timestamp convention.
pub async fn recent_practice_words_on_conn(
    conn: &Connection,
    window_days: u32,
    limit: u32,
) -> DbResult<Vec<RecentWord>> {
    if limit == 0 {
        return Ok(Vec::new());
    }
    let cutoff_ms = super::now_ms() - (window_days as i64) * 86_400_000;

    let mut rows = conn
        .query(
            "SELECT id, lemma, usage_count, first_seen_at, state \
               FROM words \
              WHERE state IN ('learning','unknown') \
                AND first_seen_at IS NOT NULL \
                AND first_seen_at >= ?1 \
              ORDER BY usage_count ASC, first_seen_at DESC \
              LIMIT ?2",
            turso::params![Value::Integer(cutoff_ms), Value::Integer(limit as i64)],
        )
        .await?;

    let mut out = Vec::with_capacity(limit as usize);
    while let Some(row) = rows.next().await? {
        let usage_count: i64 = row.get(2)?;
        out.push(RecentWord {
            id: row.get(0)?,
            lemma: row.get(1)?,
            usage_count,
            level: usage_count.min(10).max(0),
            first_seen_at: row.get(3)?,
            state: row.get(4)?,
        });
    }
    Ok(out)
}

pub async fn recent_practice_words(window_days: u32, limit: u32) -> DbResult<Vec<RecentWord>> {
    let conn = get_connection()?.lock().await;
    recent_practice_words_on_conn(&conn, window_days, limit).await
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

    /// Insert a row directly so the test does not depend on the wider
    /// command surface. `first_seen_at` is in ms-epoch like production.
    async fn seed(
        conn: &Connection,
        lemma: &str,
        state: &str,
        usage_count: i64,
        first_seen_at: i64,
    ) -> i64 {
        let now = super::super::now_ms();
        conn.execute(
            "INSERT INTO words \
               (lemma, state, state_source, usage_count, first_seen_at, \
                created_at, updated_at) \
             VALUES (?1, ?2, 'test', ?3, ?4, ?5, ?5)",
            turso::params![lemma, state, usage_count, first_seen_at, now],
        )
        .await
        .expect("seed words row");
        let mut rows = conn
            .query("SELECT id FROM words WHERE lemma = ?1", turso::params![lemma])
            .await
            .unwrap();
        rows.next().await.unwrap().unwrap().get(0).unwrap()
    }

    #[tokio::test]
    async fn register_word_use_increments_and_logs_atomically() {
        let conn = setup_db().await;
        let id = seed(&conn, "alpha", "learning", 0, super::super::now_ms()).await;

        let n1 = register_word_use_on_conn(&conn, id, SURFACE_STORY_REVIEW)
            .await
            .unwrap();
        let n2 = register_word_use_on_conn(&conn, id, SURFACE_WRITING_TRAIN)
            .await
            .unwrap();
        assert_eq!(n1, 1, "first +1 returns the new value 1");
        assert_eq!(n2, 2, "second +1 returns the new value 2");

        // Counter on the words row matches the returned value.
        let mut rows = conn
            .query(
                "SELECT usage_count FROM words WHERE id = ?1",
                turso::params![id],
            )
            .await
            .unwrap();
        let stored: i64 = rows.next().await.unwrap().unwrap().get(0).unwrap();
        assert_eq!(stored, 2);

        // Audit log captured both surfaces.
        let mut rows = conn
            .query(
                "SELECT surface FROM word_usage_log WHERE word_id = ?1 \
                  ORDER BY id ASC",
                turso::params![id],
            )
            .await
            .unwrap();
        let mut surfaces = Vec::new();
        while let Some(r) = rows.next().await.unwrap() {
            surfaces.push(r.get::<String>(0).unwrap());
        }
        assert_eq!(surfaces, vec![SURFACE_STORY_REVIEW, SURFACE_WRITING_TRAIN]);
    }

    #[tokio::test]
    async fn register_word_use_rejects_unknown_surface() {
        let conn = setup_db().await;
        let id = seed(&conn, "alpha", "learning", 0, super::super::now_ms()).await;
        let err = register_word_use_on_conn(&conn, id, "freestyle")
            .await
            .expect_err("invalid surface must error");
        assert!(err.to_string().contains("invalid usage surface"));

        // Counter still 0 — the rejected call must NOT have bumped anything.
        let mut rows = conn
            .query(
                "SELECT usage_count FROM words WHERE id = ?1",
                turso::params![id],
            )
            .await
            .unwrap();
        let stored: i64 = rows.next().await.unwrap().unwrap().get(0).unwrap();
        assert_eq!(stored, 0);
    }

    #[tokio::test]
    async fn register_word_use_errors_on_missing_word() {
        let conn = setup_db().await;
        let err = register_word_use_on_conn(&conn, 4242, SURFACE_STORY_REVIEW)
            .await
            .expect_err("missing word must error");
        assert!(err.to_string().contains("not found"));
    }

    #[tokio::test]
    async fn recent_practice_words_orders_by_usage_then_first_seen_desc() {
        let conn = setup_db().await;
        let now = super::super::now_ms();
        // Two days of slack inside the window so first_seen_at differs.
        seed(&conn, "alpha", "learning", 2, now - 1_000).await; // higher level
        seed(&conn, "bravo", "learning", 0, now - 2_000).await; // older same-level
        seed(&conn, "charlie", "unknown", 0, now - 500).await; // newer same-level
        // Out of window — must NOT appear.
        seed(&conn, "delta", "learning", 0, now - 30 * 86_400_000).await;
        // 'known' state — must NOT appear regardless of recency.
        seed(&conn, "echo", "known", 0, now - 1_000).await;

        let rows = recent_practice_words_on_conn(&conn, 14, 50).await.unwrap();
        let lemmas: Vec<&str> = rows.iter().map(|r| r.lemma.as_str()).collect();
        // Both level-0 rows come first; among them the newer (charlie) wins.
        assert_eq!(lemmas, vec!["charlie", "bravo", "alpha"]);

        // Level derivation surface check — never exceeds 10, never negative.
        for r in &rows {
            assert!(r.level >= 0 && r.level <= 10);
            assert_eq!(r.level, r.usage_count.min(10).max(0));
        }
    }

    #[tokio::test]
    async fn recent_practice_words_clamps_level_at_ten() {
        let conn = setup_db().await;
        let now = super::super::now_ms();
        seed(&conn, "alpha", "learning", 25, now - 1_000).await;
        let rows = recent_practice_words_on_conn(&conn, 14, 50).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].usage_count, 25);
        assert_eq!(rows[0].level, 10);
    }

    #[tokio::test]
    async fn recent_practice_words_honors_limit() {
        let conn = setup_db().await;
        let now = super::super::now_ms();
        for i in 0..5 {
            seed(
                &conn,
                &format!("w{i:02}"),
                "learning",
                0,
                now - 1_000 - i as i64,
            )
            .await;
        }
        let rows = recent_practice_words_on_conn(&conn, 14, 2).await.unwrap();
        assert_eq!(rows.len(), 2);
    }

    #[tokio::test]
    async fn schema_apply_is_idempotent_for_migrated_columns() {
        // Re-running apply() on an existing connection must not error
        // (covers the `usage_count` ALTER + `mcq_payload` ALTER guards).
        let conn = setup_db().await;
        crate::db::schema::apply(&conn).await.unwrap();
        crate::db::schema::apply(&conn).await.unwrap();
        // And the index + log table still satisfy basic CRUD.
        let id = seed(&conn, "alpha", "learning", 0, super::super::now_ms()).await;
        let n = register_word_use_on_conn(&conn, id, SURFACE_STORY_REVIEW)
            .await
            .unwrap();
        assert_eq!(n, 1);
    }
}
