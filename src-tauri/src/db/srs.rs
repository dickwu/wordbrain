//! FSRS schedule + review-log helpers (§4.5 of the plan).
//!
//! The scheduling math (new stability / difficulty / due after a rating) is
//! owned by `ts-fsrs` on the frontend; Rust just persists whatever the TS
//! side computes and owns the *graduation* rule — after `graduation_reps`
//! successful reps with no recent lapse, the word flips to
//! `state='known', state_source='srs'`.
//!
//! Follows the same split-surface pattern as [`super::words`] and
//! [`super::materials`]: every helper has an `*_on_conn(&Connection, …)`
//! flavour for integration tests plus a thin wrapper that grabs the global
//! connection singleton.

use serde::{Deserialize, Serialize};
use turso::Connection;

use super::{get_connection, now_ms, DbResult};

/// ts-fsrs rating enum mirrored as plain integers for IPC.
///   1 = Again, 2 = Hard, 3 = Good, 4 = Easy.
pub const RATING_AGAIN: i64 = 1;

/// Default number of successful reps before auto-promotion to `known`.
/// Overridable via settings key `srs_graduation_reps`.
pub const DEFAULT_GRADUATION_REPS: i64 = 3;

/// Window in days over which a lapse blocks graduation. A word rated Again
/// within the last `LAPSE_WINDOW_DAYS` days stays in SRS even if `reps`
/// already exceeds the threshold.
pub const LAPSE_WINDOW_DAYS: i64 = 14;

// ---------------------------------------------------------------------------
// Shapes shared with IPC / the frontend ts-fsrs layer.
// ---------------------------------------------------------------------------

/// One card due for review. Matches the subset of `ts-fsrs`'s `Card` shape
/// that the UI needs plus the joined lemma / word_id for persistence.
#[derive(Debug, Clone, Serialize)]
pub struct DueCard {
    pub word_id: i64,
    pub lemma: String,
    pub stability: f64,
    pub difficulty: f64,
    pub elapsed_days: i64,
    pub scheduled_days: i64,
    pub reps: i64,
    pub lapses: i64,
    pub last_review: Option<i64>,
    pub due: i64,
}

/// Frontend-computed FSRS update. The ts-fsrs `next(card, now, rating)` call
/// on the renderer produces these fields; Rust just writes them back.
#[derive(Debug, Clone, Deserialize)]
pub struct SchedulingUpdate {
    pub stability: f64,
    pub difficulty: f64,
    pub elapsed_days: i64,
    pub scheduled_days: i64,
    pub due: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct AddToSrsOutcome {
    pub word_id: i64,
    pub already_scheduled: bool,
    pub due: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ApplyRatingOutcome {
    pub reps: i64,
    pub lapses: i64,
    pub due: i64,
    pub graduated_to_known: bool,
}

// ---------------------------------------------------------------------------
// add_to_srs
// ---------------------------------------------------------------------------

/// Insert a row into `srs_schedule` using ts-fsrs defaults (stability=0,
/// difficulty=5, due=now). Flips `words.state` to `'learning'` if the word
/// was previously `'unknown'` so the reader highlight matches its new role.
///
/// Idempotent: if the word is already scheduled, the existing row is left in
/// place and the returned `already_scheduled` flag is `true`.
pub async fn add_to_srs_on_conn(
    conn: &Connection,
    lemma: &str,
    now: i64,
) -> DbResult<AddToSrsOutcome> {
    let lemma = lemma.trim();
    if lemma.is_empty() {
        return Err("add_to_srs: empty lemma".into());
    }

    conn.execute("BEGIN IMMEDIATE;", ()).await?;
    let tx: DbResult<AddToSrsOutcome> = async {
        // Upsert the word so the FK on srs_schedule.word_id is satisfied,
        // without clobbering a pre-existing state='known' row.
        conn.execute(
            "INSERT OR IGNORE INTO words \
               (lemma, state, state_source, created_at, updated_at, first_seen_at) \
             VALUES (?1, 'learning', 'srs', ?2, ?2, ?2)",
            turso::params![lemma, now],
        )
        .await?;

        let word_id = lookup_word_id(conn, lemma)
            .await?
            .ok_or_else(|| format!("add_to_srs: could not resolve word id for {lemma}"))?;

        // Is this word already in SRS?
        let mut rows = conn
            .query(
                "SELECT due FROM srs_schedule WHERE word_id = ?1",
                turso::params![word_id],
            )
            .await?;
        if let Some(row) = rows.next().await? {
            let existing_due: i64 = row.get(0)?;
            return Ok(AddToSrsOutcome {
                word_id,
                already_scheduled: true,
                due: existing_due,
            });
        }
        drop(rows);

        // Insert a fresh row with ts-fsrs defaults.
        conn.execute(
            "INSERT INTO srs_schedule \
               (word_id, stability, difficulty, elapsed_days, scheduled_days, \
                reps, lapses, last_review, due) \
             VALUES (?1, 0.0, 5.0, 0, 0, 0, 0, NULL, ?2)",
            turso::params![word_id, now],
        )
        .await?;

        // If the word is currently 'unknown', flip it to 'learning'/'srs' so
        // the reader stops surfacing it like a fresh import. Leave
        // state='known' rows untouched — re-adding them re-enters SRS but
        // must not downgrade a user-confirmed known word. The UI should
        // prevent this case, but defence-in-depth is cheap.
        conn.execute(
            "UPDATE words \
                SET state = 'learning', state_source = 'srs', updated_at = ?1 \
              WHERE id = ?2 AND state = 'unknown'",
            turso::params![now, word_id],
        )
        .await?;

        Ok(AddToSrsOutcome {
            word_id,
            already_scheduled: false,
            due: now,
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

pub async fn add_to_srs(lemma: &str) -> DbResult<AddToSrsOutcome> {
    let conn = get_connection()?.lock().await;
    add_to_srs_on_conn(&conn, lemma, now_ms()).await
}

/// Return whether `lemma` already has an SRS schedule row.
pub async fn is_in_srs_on_conn(conn: &Connection, lemma: &str) -> DbResult<bool> {
    let lemma = lemma.trim();
    if lemma.is_empty() {
        return Ok(false);
    }

    let mut rows = conn
        .query(
            "SELECT 1 \
               FROM srs_schedule s \
               JOIN words w ON w.id = s.word_id \
              WHERE w.lemma = ?1 COLLATE NOCASE \
              LIMIT 1",
            turso::params![lemma],
        )
        .await?;
    Ok(rows.next().await?.is_some())
}

pub async fn is_in_srs(lemma: &str) -> DbResult<bool> {
    let conn = get_connection()?.lock().await;
    is_in_srs_on_conn(&conn, lemma).await
}

// ---------------------------------------------------------------------------
// list_due / count_due
// ---------------------------------------------------------------------------

/// Every scheduled card whose `due <= now`, oldest-due first. The ReviewSession
/// drains this queue in order; ties broken by `word_id` for stability.
pub async fn list_due_on_conn(conn: &Connection, now: i64) -> DbResult<Vec<DueCard>> {
    let mut rows = conn
        .query(
            "SELECT s.word_id, w.lemma, s.stability, s.difficulty, \
                    s.elapsed_days, s.scheduled_days, s.reps, s.lapses, \
                    s.last_review, s.due \
               FROM srs_schedule s \
               JOIN words w ON w.id = s.word_id \
              WHERE s.due <= ?1 \
              ORDER BY s.due ASC, s.word_id ASC",
            turso::params![now],
        )
        .await?;

    let mut out = Vec::new();
    while let Some(row) = rows.next().await? {
        out.push(DueCard {
            word_id: row.get::<i64>(0)?,
            lemma: row.get::<String>(1)?,
            stability: row.get::<f64>(2)?,
            difficulty: row.get::<f64>(3)?,
            elapsed_days: row.get::<i64>(4)?,
            scheduled_days: row.get::<i64>(5)?,
            reps: row.get::<i64>(6)?,
            lapses: row.get::<i64>(7)?,
            last_review: nullable_i64(&row, 8)?,
            due: row.get::<i64>(9)?,
        });
    }
    Ok(out)
}

pub async fn list_due(now: i64) -> DbResult<Vec<DueCard>> {
    let conn = get_connection()?.lock().await;
    list_due_on_conn(&conn, now).await
}

pub async fn count_due_on_conn(conn: &Connection, now: i64) -> DbResult<i64> {
    let mut rows = conn
        .query(
            "SELECT COUNT(*) FROM srs_schedule WHERE due <= ?1",
            turso::params![now],
        )
        .await?;
    if let Some(row) = rows.next().await? {
        Ok(row.get::<i64>(0)?)
    } else {
        Ok(0)
    }
}

pub async fn count_due(now: i64) -> DbResult<i64> {
    let conn = get_connection()?.lock().await;
    count_due_on_conn(&conn, now).await
}

// ---------------------------------------------------------------------------
// apply_rating
// ---------------------------------------------------------------------------

/// Commit a review: update the schedule row with the ts-fsrs-computed values,
/// append to `srs_review_log`, and graduate the word to `state='known',
/// state_source='srs'` if it has reached `graduation_reps` successful reps
/// with no lapse in the last `LAPSE_WINDOW_DAYS` days.
pub async fn apply_rating_on_conn(
    conn: &Connection,
    lemma: &str,
    rating: i64,
    update: &SchedulingUpdate,
    reviewed_at: i64,
    graduation_reps: i64,
) -> DbResult<ApplyRatingOutcome> {
    let lemma = lemma.trim();
    if lemma.is_empty() {
        return Err("apply_rating: empty lemma".into());
    }
    if !(RATING_AGAIN..=4).contains(&rating) {
        return Err(format!("apply_rating: rating out of range (got {rating})").into());
    }

    conn.execute("BEGIN IMMEDIATE;", ()).await?;
    let tx: DbResult<ApplyRatingOutcome> = async {
        let word_id = lookup_word_id(conn, lemma)
            .await?
            .ok_or_else(|| format!("apply_rating: word `{lemma}` is not in the words table"))?;

        // Read the pre-update schedule row so we can log prev_stability and
        // decide reps/lapses deltas based on the rating.
        let (prev_stability, prev_reps, prev_lapses) =
            read_schedule_snapshot(conn, word_id).await?;

        let new_reps = prev_reps + 1;
        let new_lapses = if rating == RATING_AGAIN {
            prev_lapses + 1
        } else {
            prev_lapses
        };

        conn.execute(
            "UPDATE srs_schedule \
                SET stability = ?1, difficulty = ?2, elapsed_days = ?3, \
                    scheduled_days = ?4, reps = ?5, lapses = ?6, \
                    last_review = ?7, due = ?8 \
              WHERE word_id = ?9",
            turso::params![
                update.stability,
                update.difficulty,
                update.elapsed_days,
                update.scheduled_days,
                new_reps,
                new_lapses,
                reviewed_at,
                update.due,
                word_id,
            ],
        )
        .await?;

        conn.execute(
            "INSERT INTO srs_review_log \
               (word_id, rating, reviewed_at, prev_stability, new_stability) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            turso::params![
                word_id,
                rating,
                reviewed_at,
                prev_stability,
                update.stability,
            ],
        )
        .await?;

        // Graduation check. A word graduates when:
        //   (a) it has been reviewed `graduation_reps` times (reps >= N), AND
        //   (b) no `rating == Again` has been recorded in the last
        //       LAPSE_WINDOW_DAYS days.
        let mut graduated = false;
        if new_reps >= graduation_reps {
            let window_start = reviewed_at - LAPSE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
            let mut lapse_rows = conn
                .query(
                    "SELECT COUNT(*) FROM srs_review_log \
                      WHERE word_id = ?1 AND rating = ?2 AND reviewed_at >= ?3",
                    turso::params![word_id, RATING_AGAIN, window_start],
                )
                .await?;
            let lapses_in_window: i64 = lapse_rows
                .next()
                .await?
                .map(|r| r.get::<i64>(0))
                .transpose()?
                .unwrap_or(0);
            drop(lapse_rows);

            if lapses_in_window == 0 {
                conn.execute(
                    "UPDATE words \
                        SET state = 'known', state_source = 'srs', \
                            marked_known_at = ?1, updated_at = ?1 \
                      WHERE id = ?2 AND state <> 'known'",
                    turso::params![reviewed_at, word_id],
                )
                .await?;
                graduated = true;
            }
        }

        Ok(ApplyRatingOutcome {
            reps: new_reps,
            lapses: new_lapses,
            due: update.due,
            graduated_to_known: graduated,
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

pub async fn apply_rating(
    lemma: &str,
    rating: i64,
    update: &SchedulingUpdate,
    reviewed_at: i64,
    graduation_reps: i64,
) -> DbResult<ApplyRatingOutcome> {
    let conn = get_connection()?.lock().await;
    apply_rating_on_conn(&conn, lemma, rating, update, reviewed_at, graduation_reps).await
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async fn read_schedule_snapshot(conn: &Connection, word_id: i64) -> DbResult<(f64, i64, i64)> {
    let mut rows = conn
        .query(
            "SELECT stability, reps, lapses FROM srs_schedule WHERE word_id = ?1",
            turso::params![word_id],
        )
        .await?;
    if let Some(row) = rows.next().await? {
        let stab: f64 = row.get(0)?;
        let reps: i64 = row.get(1)?;
        let lapses: i64 = row.get(2)?;
        Ok((stab, reps, lapses))
    } else {
        Err("apply_rating: word is not scheduled — call add_to_srs first".into())
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
