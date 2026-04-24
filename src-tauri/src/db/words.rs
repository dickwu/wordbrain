//! Query helpers for the `words` table.
//!
//! Every helper has two forms: an `*_on_conn(&Connection, …)` routine that
//! holds the real SQL, and a wrapper that grabs the global connection and
//! delegates. Integration tests drive the `*_on_conn` variants directly so
//! the persistence contract can be exercised across a simulated restart
//! without fighting the `OnceLock`-backed singleton.

use turso::{params_from_iter, Connection, Value};

use super::{get_connection, now_ms, DbResult};

/// Flat row returned by [`list_words_on_conn`]. Mirrors §4.1 of
/// `.omc/plans/words-manager-v1.md`; `material_count` is a correlated
/// subquery over `word_materials`.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WordRecord {
    pub id: i64,
    pub lemma: String,
    pub state: String,
    pub state_source: Option<String>,
    pub freq_rank: Option<i64>,
    pub exposure_count: i64,
    pub marked_known_at: Option<i64>,
    pub user_note: Option<String>,
    pub material_count: i64,
}

/// Filter accepted by [`list_words_on_conn`]. All fields are optional; an
/// absent / empty `states` defaults to `('known', 'learning')`. `'unknown'`
/// is silently dropped from `states` to prevent scope leak — the Words tab
/// only ever renders known / learning rows.
#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListWordsFilter {
    pub states: Option<Vec<String>>,
    pub sources: Option<Vec<String>>,
    pub search_prefix: Option<String>,
}

/// Bulk-insert `(lemma, rank)` pairs with `state='known'`, `state_source='seed_freq'`.
///
/// Uses `INSERT OR IGNORE` so an already-known lemma is left untouched. Runs
/// inside a single transaction for speed — seeding 10k rows should take well
/// under a second on a 2021 MBP.
pub async fn seed_known_from_frequency_on_conn(
    conn: &Connection,
    entries: &[(String, u32)],
) -> DbResult<u32> {
    if entries.is_empty() {
        return Ok(0);
    }
    let now = now_ms();

    conn.execute("BEGIN IMMEDIATE;", ()).await?;
    let mut inserted: u32 = 0;
    let result: DbResult<()> = async {
        for (lemma, rank) in entries {
            // `changes()` reports 1 for inserted and 0 for ignored (already present).
            conn.execute(
                "INSERT OR IGNORE INTO words \
                   (lemma, state, state_source, freq_rank, created_at, updated_at, marked_known_at) \
                 VALUES (?1, 'known', 'seed_freq', ?2, ?3, ?3, ?3)",
                turso::params![lemma.as_str(), *rank as i64, now],
            )
            .await?;
            let mut rows = conn.query("SELECT changes()", ()).await?;
            if let Some(row) = rows.next().await? {
                let changed: i64 = row.get(0)?;
                if changed > 0 {
                    inserted += 1;
                }
            }
        }
        Ok(())
    }
    .await;

    match result {
        Ok(()) => {
            conn.execute("COMMIT;", ()).await?;
            Ok(inserted)
        }
        Err(e) => {
            let _ = conn.execute("ROLLBACK;", ()).await;
            Err(e)
        }
    }
}

pub async fn seed_known_from_frequency(entries: &[(String, u32)]) -> DbResult<u32> {
    let conn = get_connection()?.lock().await;
    seed_known_from_frequency_on_conn(&conn, entries).await
}

/// Return every lemma where `state = 'known'`. Used to hydrate the in-memory
/// known-set at app start.
pub async fn get_all_known_lemmas_on_conn(conn: &Connection) -> DbResult<Vec<String>> {
    let mut rows = conn
        .query("SELECT lemma FROM words WHERE state = 'known'", ())
        .await?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().await? {
        out.push(row.get::<String>(0)?);
    }
    Ok(out)
}

pub async fn get_all_known_lemmas() -> DbResult<Vec<String>> {
    let conn = get_connection()?.lock().await;
    get_all_known_lemmas_on_conn(&conn).await
}

/// Upsert `lemma` as known. `source` defaults to `"manual"` when `None`.
pub async fn mark_known_on_conn(
    conn: &Connection,
    lemma: &str,
    source: Option<&str>,
) -> DbResult<()> {
    let now = now_ms();
    let source = source.unwrap_or("manual");
    conn.execute(
        "INSERT INTO words \
           (lemma, state, state_source, created_at, updated_at, marked_known_at) \
         VALUES (?1, 'known', ?2, ?3, ?3, ?3) \
         ON CONFLICT(lemma) DO UPDATE SET \
           state = 'known', \
           state_source = excluded.state_source, \
           marked_known_at = excluded.marked_known_at, \
           updated_at = excluded.updated_at",
        turso::params![lemma, source, now],
    )
    .await?;
    Ok(())
}

pub async fn mark_known(lemma: &str, source: Option<&str>) -> DbResult<()> {
    let conn = get_connection()?.lock().await;
    mark_known_on_conn(&conn, lemma, source).await
}

/// Flip `lemma` back to `state = 'unknown'`. No-op if the lemma is absent.
pub async fn unmark_known_on_conn(conn: &Connection, lemma: &str) -> DbResult<()> {
    let now = now_ms();
    conn.execute(
        "UPDATE words SET state = 'unknown', state_source = NULL, marked_known_at = NULL, \
                         updated_at = ?2 \
         WHERE lemma = ?1",
        turso::params![lemma, now],
    )
    .await?;
    Ok(())
}

pub async fn unmark_known(lemma: &str) -> DbResult<()> {
    let conn = get_connection()?.lock().await;
    unmark_known_on_conn(&conn, lemma).await
}

/// Total count of rows where `state = 'known'`. Cheap diagnostic for the UI.
pub async fn count_known_on_conn(conn: &Connection) -> DbResult<u64> {
    let mut rows = conn
        .query("SELECT COUNT(*) FROM words WHERE state = 'known'", ())
        .await?;
    if let Some(row) = rows.next().await? {
        let n: i64 = row.get(0)?;
        Ok(n as u64)
    } else {
        Ok(0)
    }
}

pub async fn count_known() -> DbResult<u64> {
    let conn = get_connection()?.lock().await;
    count_known_on_conn(&conn).await
}

/// Return every `words` row matching `filter`, ordered by lemma ASC.
///
/// The query is assembled dynamically because Turso's positional-params API
/// does not expand slices, so each `IN (…)` clause needs a freshly-generated
/// `?, ?, …` placeholder list. Values are still bound via
/// [`turso::params_from_iter`] — never interpolated — so there is no
/// injection surface.
pub async fn list_words_on_conn(
    conn: &Connection,
    filter: &ListWordsFilter,
) -> DbResult<Vec<WordRecord>> {
    // --- states -----------------------------------------------------------
    // Default is known + learning; 'unknown' is silently dropped even if
    // the caller supplied it (AC contract: the Words tab never shows
    // state='unknown').
    let state_values: Vec<String> = match &filter.states {
        Some(raw) if !raw.is_empty() => {
            let filtered: Vec<String> = raw
                .iter()
                .filter(|s| s.as_str() != "unknown")
                .cloned()
                .collect();
            if filtered.is_empty() {
                vec!["known".to_string(), "learning".to_string()]
            } else {
                filtered
            }
        }
        _ => vec!["known".to_string(), "learning".to_string()],
    };

    // --- sources ----------------------------------------------------------
    let source_values: Option<Vec<String>> =
        filter.sources.as_ref().filter(|v| !v.is_empty()).cloned();

    // --- prefix -----------------------------------------------------------
    let prefix_value: Option<String> = filter
        .search_prefix
        .as_ref()
        .filter(|s| !s.is_empty())
        .cloned();

    // --- build SQL + bindings --------------------------------------------
    let state_placeholders = vec!["?"; state_values.len()].join(", ");
    let mut sql = format!(
        "SELECT w.id, w.lemma, w.state, w.state_source, w.freq_rank, \
                w.exposure_count, w.marked_known_at, w.user_note, \
                (SELECT COUNT(*) FROM word_materials wm WHERE wm.word_id = w.id) AS material_count \
           FROM words w \
          WHERE w.state IN ({state_placeholders})"
    );

    let mut bindings: Vec<Value> = state_values.into_iter().map(Value::Text).collect();

    if let Some(sources) = &source_values {
        let src_placeholders = vec!["?"; sources.len()].join(", ");
        sql.push_str(&format!(" AND w.state_source IN ({src_placeholders})"));
        bindings.extend(sources.iter().cloned().map(Value::Text));
    }

    if let Some(prefix) = &prefix_value {
        sql.push_str(" AND w.lemma LIKE ? || '%'");
        bindings.push(Value::Text(prefix.clone()));
    }

    sql.push_str(" ORDER BY w.lemma ASC");

    let mut rows = conn.query(&sql, params_from_iter(bindings)).await?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().await? {
        out.push(WordRecord {
            id: row.get::<i64>(0)?,
            lemma: row.get::<String>(1)?,
            state: row.get::<String>(2)?,
            state_source: row.get::<Option<String>>(3)?,
            freq_rank: row.get::<Option<i64>>(4)?,
            exposure_count: row.get::<i64>(5)?,
            marked_known_at: row.get::<Option<i64>>(6)?,
            user_note: row.get::<Option<String>>(7)?,
            material_count: row.get::<i64>(8)?,
        });
    }
    Ok(out)
}

pub async fn list_words(filter: &ListWordsFilter) -> DbResult<Vec<WordRecord>> {
    let conn = get_connection()?.lock().await;
    list_words_on_conn(&conn, filter).await
}

/// Flip every lemma in `lemmas` back to `state='unknown'` in a single
/// `BEGIN IMMEDIATE` transaction. Clears `state_source` and
/// `marked_known_at`; bumps `updated_at`. Returns the number of rows
/// actually changed (lemmas absent from `words` contribute 0).
///
/// Empty slice → no SQL, returns 0.
pub async fn bulk_unmark_known_on_conn(conn: &Connection, lemmas: &[String]) -> DbResult<u64> {
    if lemmas.is_empty() {
        return Ok(0);
    }

    let now = now_ms();
    conn.execute("BEGIN IMMEDIATE;", ()).await?;

    let result: DbResult<u64> = async {
        let placeholders = vec!["?"; lemmas.len()].join(", ");
        let sql = format!(
            "UPDATE words \
                SET state = 'unknown', \
                    state_source = NULL, \
                    marked_known_at = NULL, \
                    updated_at = ? \
              WHERE lemma IN ({placeholders})"
        );

        let mut bindings: Vec<Value> = Vec::with_capacity(lemmas.len() + 1);
        bindings.push(Value::Integer(now));
        bindings.extend(lemmas.iter().cloned().map(Value::Text));

        conn.execute(&sql, params_from_iter(bindings)).await?;

        // `SELECT changes()` reports rows affected by the most recent
        // statement — same pattern as `seed_known_from_frequency_on_conn`.
        let mut rows = conn.query("SELECT changes()", ()).await?;
        let changed: i64 = if let Some(row) = rows.next().await? {
            row.get(0)?
        } else {
            0
        };
        Ok(changed as u64)
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

pub async fn bulk_unmark_known(lemmas: &[String]) -> DbResult<u64> {
    let conn = get_connection()?.lock().await;
    bulk_unmark_known_on_conn(&conn, lemmas).await
}

/// Transition `lemma` to `state`. Only `'known' | 'learning' | 'unknown'`
/// are accepted; anything else returns an `Err` (surfaces as a plain string
/// at the IPC boundary, matching project convention).
///
/// Moving to `'known'` stamps `marked_known_at = now_ms()`; moving away
/// from `'known'` clears both `state_source` and `marked_known_at`.
pub async fn set_word_state_on_conn(conn: &Connection, lemma: &str, state: &str) -> DbResult<()> {
    if !matches!(state, "known" | "learning" | "unknown") {
        return Err(format!("invalid word state: {state}").into());
    }
    let now = now_ms();
    if state == "known" {
        conn.execute(
            "UPDATE words \
                SET state = 'known', \
                    marked_known_at = ?2, \
                    updated_at = ?2 \
              WHERE lemma = ?1",
            turso::params![lemma, now],
        )
        .await?;
    } else {
        // learning | unknown — wipe the known-only bookkeeping.
        conn.execute(
            "UPDATE words \
                SET state = ?2, \
                    state_source = NULL, \
                    marked_known_at = NULL, \
                    updated_at = ?3 \
              WHERE lemma = ?1",
            turso::params![lemma, state, now],
        )
        .await?;
    }
    Ok(())
}

pub async fn set_word_state(lemma: &str, state: &str) -> DbResult<()> {
    let conn = get_connection()?.lock().await;
    set_word_state_on_conn(&conn, lemma, state).await
}

/// Overwrite `user_note` for `lemma`. Whitespace is trimmed; `None` or an
/// all-whitespace string stores SQL `NULL`. Always bumps `updated_at`.
pub async fn set_user_note_on_conn(
    conn: &Connection,
    lemma: &str,
    note: Option<&str>,
) -> DbResult<()> {
    let trimmed = note
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let now = now_ms();
    let note_value = match trimmed {
        Some(s) => Value::Text(s),
        None => Value::Null,
    };
    conn.execute(
        "UPDATE words SET user_note = ?2, updated_at = ?3 WHERE lemma = ?1",
        params_from_iter(vec![
            Value::Text(lemma.to_string()),
            note_value,
            Value::Integer(now),
        ]),
    )
    .await?;
    Ok(())
}

pub async fn set_user_note(lemma: &str, note: Option<&str>) -> DbResult<()> {
    let conn = get_connection()?.lock().await;
    set_user_note_on_conn(&conn, lemma, note).await
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

    /// Insert a row with an explicit state + source for filter tests.
    async fn seed_word(conn: &Connection, lemma: &str, state: &str, source: Option<&str>) {
        let now = now_ms();
        conn.execute(
            "INSERT INTO words (lemma, state, state_source, created_at, updated_at, marked_known_at) \
             VALUES (?1, ?2, ?3, ?4, ?4, CASE WHEN ?2 = 'known' THEN ?4 ELSE NULL END)",
            turso::params![lemma, state, source, now],
        )
        .await
        .expect("seed row");
    }

    #[tokio::test]
    async fn list_words_returns_both_known_and_learning_by_default() {
        let conn = setup_db().await;
        seed_word(&conn, "alpha", "known", Some("seed_freq")).await;
        seed_word(&conn, "bravo", "learning", Some("manual")).await;
        seed_word(&conn, "charlie", "unknown", None).await;

        let rows = list_words_on_conn(&conn, &ListWordsFilter::default())
            .await
            .unwrap();
        let lemmas: Vec<&str> = rows.iter().map(|r| r.lemma.as_str()).collect();
        assert_eq!(lemmas, vec!["alpha", "bravo"]);
    }

    #[tokio::test]
    async fn list_words_filters_by_state_known_only() {
        let conn = setup_db().await;
        seed_word(&conn, "alpha", "known", Some("seed_freq")).await;
        seed_word(&conn, "bravo", "learning", Some("manual")).await;

        let rows = list_words_on_conn(
            &conn,
            &ListWordsFilter {
                states: Some(vec!["known".to_string()]),
                ..ListWordsFilter::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].lemma, "alpha");
    }

    #[tokio::test]
    async fn list_words_filters_by_source_subset() {
        let conn = setup_db().await;
        seed_word(&conn, "alpha", "known", Some("seed_freq")).await;
        seed_word(&conn, "bravo", "known", Some("manual")).await;
        seed_word(&conn, "charlie", "known", Some("manual_list")).await;
        seed_word(&conn, "delta", "learning", Some("review_graduated")).await;

        let rows = list_words_on_conn(
            &conn,
            &ListWordsFilter {
                sources: Some(vec!["manual".to_string(), "manual_list".to_string()]),
                ..ListWordsFilter::default()
            },
        )
        .await
        .unwrap();
        let lemmas: Vec<&str> = rows.iter().map(|r| r.lemma.as_str()).collect();
        assert_eq!(lemmas, vec!["bravo", "charlie"]);
    }

    #[tokio::test]
    async fn list_words_prefix_search_case_insensitive() {
        let conn = setup_db().await;
        // All lemmas are lowercase in storage (project convention); the
        // FE lowercases the search before it hits the backend. We verify
        // lowercase-prefix → lowercase-lemma match here.
        seed_word(&conn, "apple", "known", Some("manual")).await;
        seed_word(&conn, "apricot", "known", Some("manual")).await;
        seed_word(&conn, "banana", "known", Some("manual")).await;

        let rows = list_words_on_conn(
            &conn,
            &ListWordsFilter {
                search_prefix: Some("ap".to_string()),
                ..ListWordsFilter::default()
            },
        )
        .await
        .unwrap();
        let lemmas: Vec<&str> = rows.iter().map(|r| r.lemma.as_str()).collect();
        assert_eq!(lemmas, vec!["apple", "apricot"]);
    }

    #[tokio::test]
    async fn list_words_excludes_unknown_state_even_if_requested() {
        let conn = setup_db().await;
        seed_word(&conn, "alpha", "known", Some("manual")).await;
        seed_word(&conn, "bravo", "unknown", None).await;

        let rows = list_words_on_conn(
            &conn,
            &ListWordsFilter {
                states: Some(vec![
                    "known".to_string(),
                    "unknown".to_string(), // must be silently dropped
                ]),
                ..ListWordsFilter::default()
            },
        )
        .await
        .unwrap();
        let lemmas: Vec<&str> = rows.iter().map(|r| r.lemma.as_str()).collect();
        assert_eq!(lemmas, vec!["alpha"]);
    }

    #[tokio::test]
    async fn list_words_material_count_subquery_accurate() {
        let conn = setup_db().await;
        seed_word(&conn, "alpha", "known", Some("manual")).await;
        seed_word(&conn, "bravo", "known", Some("manual")).await;

        // Create two materials and wire them up so "alpha" appears in 2
        // materials, "bravo" in 0.
        let now = now_ms();
        for i in 1..=2 {
            conn.execute(
                "INSERT INTO materials \
                   (title, source_kind, tiptap_json, raw_text, total_tokens, \
                    unique_tokens, unknown_count_at_import, created_at) \
                 VALUES (?1, 'paste', '{}', 'x', 1, 1, 0, ?2)",
                turso::params![format!("m{i}"), now],
            )
            .await
            .unwrap();
        }
        // Fetch word + material ids.
        let alpha_id: i64 = {
            let mut r = conn
                .query("SELECT id FROM words WHERE lemma = 'alpha'", ())
                .await
                .unwrap();
            r.next().await.unwrap().unwrap().get(0).unwrap()
        };
        for mid in 1i64..=2 {
            conn.execute(
                "INSERT INTO word_materials (word_id, material_id, occurrence_count, first_position) \
                 VALUES (?1, ?2, 1, 0)",
                turso::params![alpha_id, mid],
            )
            .await
            .unwrap();
        }

        let rows = list_words_on_conn(&conn, &ListWordsFilter::default())
            .await
            .unwrap();
        let alpha = rows.iter().find(|r| r.lemma == "alpha").unwrap();
        let bravo = rows.iter().find(|r| r.lemma == "bravo").unwrap();
        assert_eq!(alpha.material_count, 2);
        assert_eq!(bravo.material_count, 0);
    }

    #[tokio::test]
    async fn bulk_unmark_known_single_transaction_atomic() {
        let conn = setup_db().await;
        mark_known_on_conn(&conn, "alpha", Some("manual"))
            .await
            .unwrap();
        mark_known_on_conn(&conn, "bravo", Some("manual"))
            .await
            .unwrap();
        mark_known_on_conn(&conn, "charlie", Some("manual"))
            .await
            .unwrap();

        // All three live under one COMMIT — the helper wraps BEGIN IMMEDIATE
        // around the UPDATE, so the rows_affected value is the total set.
        let n = bulk_unmark_known_on_conn(
            &conn,
            &[
                "alpha".to_string(),
                "bravo".to_string(),
                "charlie".to_string(),
            ],
        )
        .await
        .unwrap();
        assert_eq!(n, 3);

        // Nothing left in state='known' — confirms the transaction committed
        // and every row was flipped together.
        let remaining = count_known_on_conn(&conn).await.unwrap();
        assert_eq!(remaining, 0);

        // Verify one row's fields explicitly.
        let mut rows = conn
            .query(
                "SELECT state, state_source, marked_known_at FROM words WHERE lemma = 'alpha'",
                (),
            )
            .await
            .unwrap();
        let row = rows.next().await.unwrap().unwrap();
        let state: String = row.get(0).unwrap();
        let source: Option<String> = row.get(1).unwrap();
        let marked: Option<i64> = row.get(2).unwrap();
        assert_eq!(state, "unknown");
        assert_eq!(source, None);
        assert_eq!(marked, None);
    }

    #[tokio::test]
    async fn bulk_unmark_known_empty_slice_noop() {
        let conn = setup_db().await;
        mark_known_on_conn(&conn, "alpha", Some("manual"))
            .await
            .unwrap();

        let n = bulk_unmark_known_on_conn(&conn, &[]).await.unwrap();
        assert_eq!(n, 0);
        assert_eq!(count_known_on_conn(&conn).await.unwrap(), 1);
    }

    #[tokio::test]
    async fn set_word_state_rejects_invalid_state() {
        let conn = setup_db().await;
        mark_known_on_conn(&conn, "alpha", Some("manual"))
            .await
            .unwrap();
        let err = set_word_state_on_conn(&conn, "alpha", "graduated")
            .await
            .expect_err("invalid state must error");
        assert!(
            err.to_string().contains("invalid word state"),
            "unexpected error: {err}"
        );
    }

    #[tokio::test]
    async fn set_word_state_round_trip_known_learning() {
        let conn = setup_db().await;
        mark_known_on_conn(&conn, "alpha", Some("manual"))
            .await
            .unwrap();

        // known → learning clears marked_known_at + state_source.
        set_word_state_on_conn(&conn, "alpha", "learning")
            .await
            .unwrap();
        let mut rows = conn
            .query(
                "SELECT state, state_source, marked_known_at FROM words WHERE lemma = 'alpha'",
                (),
            )
            .await
            .unwrap();
        let row = rows.next().await.unwrap().unwrap();
        let state: String = row.get(0).unwrap();
        let source: Option<String> = row.get(1).unwrap();
        let marked: Option<i64> = row.get(2).unwrap();
        assert_eq!(state, "learning");
        assert_eq!(source, None);
        assert_eq!(marked, None);

        // learning → known re-stamps marked_known_at.
        set_word_state_on_conn(&conn, "alpha", "known")
            .await
            .unwrap();
        let mut rows = conn
            .query(
                "SELECT state, marked_known_at FROM words WHERE lemma = 'alpha'",
                (),
            )
            .await
            .unwrap();
        let row = rows.next().await.unwrap().unwrap();
        let state: String = row.get(0).unwrap();
        let marked: Option<i64> = row.get(1).unwrap();
        assert_eq!(state, "known");
        assert!(marked.is_some());
    }

    #[tokio::test]
    async fn set_user_note_empty_stores_null() {
        let conn = setup_db().await;
        mark_known_on_conn(&conn, "alpha", Some("manual"))
            .await
            .unwrap();

        // Seed a non-empty note first, then clear it via both the explicit
        // `None` path and the trim-to-empty path.
        set_user_note_on_conn(&conn, "alpha", Some("temporary"))
            .await
            .unwrap();
        set_user_note_on_conn(&conn, "alpha", None).await.unwrap();
        let mut rows = conn
            .query("SELECT user_note FROM words WHERE lemma = 'alpha'", ())
            .await
            .unwrap();
        let row = rows.next().await.unwrap().unwrap();
        let note: Option<String> = row.get(0).unwrap();
        assert_eq!(note, None);

        set_user_note_on_conn(&conn, "alpha", Some("   "))
            .await
            .unwrap();
        let mut rows = conn
            .query("SELECT user_note FROM words WHERE lemma = 'alpha'", ())
            .await
            .unwrap();
        let row = rows.next().await.unwrap().unwrap();
        let note: Option<String> = row.get(0).unwrap();
        assert_eq!(note, None, "whitespace-only note must also store NULL");
    }

    #[tokio::test]
    async fn set_user_note_round_trip_preserves_unicode() {
        let conn = setup_db().await;
        mark_known_on_conn(&conn, "alpha", Some("manual"))
            .await
            .unwrap();

        let note = "TOEFL §3 — 记忆点 🎯";
        set_user_note_on_conn(&conn, "alpha", Some(note))
            .await
            .unwrap();
        let mut rows = conn
            .query("SELECT user_note FROM words WHERE lemma = 'alpha'", ())
            .await
            .unwrap();
        let row = rows.next().await.unwrap().unwrap();
        let stored: Option<String> = row.get(0).unwrap();
        assert_eq!(stored.as_deref(), Some(note));
    }
}
