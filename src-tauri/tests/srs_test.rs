//! AC4 — three Good ratings across 7 simulated days auto-promote the word
//! to `state='known'` / `state_source='srs'`.
//!
//! Exercises the full persistence path the Tauri command takes:
//!   add_to_srs_on_conn → apply_rating_on_conn (×3, with injected clock) →
//!   graduation check → `words` state flip.
//!
//! The ts-fsrs scheduling math lives on the renderer; here we fabricate
//! plausible `SchedulingUpdate` values (stability climbing, due pushed out)
//! because the graduation rule only depends on `reps` and recent lapses.

use tempfile::TempDir;
use turso::Builder;
use wordbrain_lib::db::{
    schema,
    srs::{
        add_to_srs_on_conn, apply_rating_on_conn, count_due_on_conn, list_due_on_conn,
        SchedulingUpdate, DEFAULT_GRADUATION_REPS,
    },
};

async fn open(path: &std::path::Path) -> turso::Connection {
    let db = Builder::new_local(path.to_str().expect("utf8 path"))
        .build()
        .await
        .expect("build turso db");
    let conn = db.connect().expect("connect turso db");
    let _ = conn.execute("PRAGMA foreign_keys = ON;", ()).await;
    conn
}

const DAY_MS: i64 = 24 * 60 * 60 * 1000;
const RATING_GOOD: i64 = 3;

#[tokio::test]
async fn three_goods_across_seven_days_promotes_word_to_known_via_srs() {
    let dir = TempDir::new().expect("tempdir");
    let db_path = dir.path().join("wordbrain.db");
    let conn = open(&db_path).await;
    schema::apply(&conn).await.expect("apply schema");

    // t0 = a fixed epoch ms so the simulated clock is deterministic.
    // Choose a value well past 1970 so `window_start` never goes negative.
    let t0: i64 = 1_700_000_000_000;
    let lemma = "perspicacious";

    // --- Add the word to SRS. Word has never been seen; add_to_srs should
    //     upsert it with state='learning', state_source='srs'. ---
    let added = add_to_srs_on_conn(&conn, lemma, t0)
        .await
        .expect("add to srs");
    assert!(!added.already_scheduled);
    assert_eq!(added.due, t0, "initial due must equal now");
    assert_eq!(
        count_due_on_conn(&conn, t0).await.unwrap(),
        1,
        "one card due at t0"
    );

    // Confirm the word state was initialised correctly.
    {
        let mut rows = conn
            .query(
                "SELECT state, state_source FROM words WHERE lemma = ?1",
                turso::params![lemma],
            )
            .await
            .unwrap();
        let row = rows.next().await.unwrap().expect("row");
        let state: String = row.get(0).unwrap();
        let source: String = row.get(1).unwrap();
        assert_eq!(state, "learning");
        assert_eq!(source, "srs");
    }

    // --- Simulate three Good ratings at day 0, day 3, day 7. Each `update`
    //     pushes `due` further out (like ts-fsrs would). Stability/difficulty
    //     values are plausible but not canonical — the graduation rule only
    //     cares about reps and lapses. ---
    let schedule = [
        (
            t0,
            SchedulingUpdate {
                stability: 1.0,
                difficulty: 5.0,
                elapsed_days: 0,
                scheduled_days: 3,
                due: t0 + 3 * DAY_MS,
            },
        ),
        (
            t0 + 3 * DAY_MS,
            SchedulingUpdate {
                stability: 5.0,
                difficulty: 5.0,
                elapsed_days: 3,
                scheduled_days: 4,
                due: t0 + 7 * DAY_MS,
            },
        ),
        (
            t0 + 7 * DAY_MS,
            SchedulingUpdate {
                stability: 15.0,
                difficulty: 5.0,
                elapsed_days: 4,
                scheduled_days: 10,
                due: t0 + 17 * DAY_MS,
            },
        ),
    ];

    let mut outcomes = Vec::new();
    for (now, upd) in &schedule {
        let out = apply_rating_on_conn(
            &conn,
            lemma,
            RATING_GOOD,
            upd,
            *now,
            DEFAULT_GRADUATION_REPS,
        )
        .await
        .expect("apply rating");
        outcomes.push(out);
    }

    // First two ratings should not graduate yet.
    assert!(!outcomes[0].graduated_to_known, "rep 1 must not graduate");
    assert_eq!(outcomes[0].reps, 1);
    assert!(!outcomes[1].graduated_to_known, "rep 2 must not graduate");
    assert_eq!(outcomes[1].reps, 2);

    // Third Good rating must flip the word to state='known', state_source='srs'.
    assert!(
        outcomes[2].graduated_to_known,
        "rep 3 with no lapses should promote to known"
    );
    assert_eq!(outcomes[2].reps, 3);
    assert_eq!(outcomes[2].lapses, 0);

    // Verify the actual `words` row.
    {
        let mut rows = conn
            .query(
                "SELECT state, state_source, marked_known_at FROM words WHERE lemma = ?1",
                turso::params![lemma],
            )
            .await
            .unwrap();
        let row = rows.next().await.unwrap().expect("row");
        let state: String = row.get(0).unwrap();
        let source: String = row.get(1).unwrap();
        let marked: i64 = row.get(2).unwrap();
        assert_eq!(state, "known");
        assert_eq!(source, "srs");
        assert_eq!(
            marked,
            t0 + 7 * DAY_MS,
            "marked_known_at must reflect the reviewed_at of the graduating rep"
        );
    }

    // And the review log should have exactly three entries.
    {
        let mut rows = conn
            .query(
                "SELECT COUNT(*) FROM srs_review_log \
                   WHERE word_id = (SELECT id FROM words WHERE lemma = ?1)",
                turso::params![lemma],
            )
            .await
            .unwrap();
        let row = rows.next().await.unwrap().expect("row");
        let n: i64 = row.get(0).unwrap();
        assert_eq!(n, 3, "one log row per rating");
    }

    // After graduation, the card's `due` is whatever ts-fsrs-produced value
    // we wrote — with a 17-day horizon the card should NOT be due at t0+7d.
    let still_due = list_due_on_conn(&conn, t0 + 7 * DAY_MS).await.unwrap();
    assert!(
        still_due.iter().all(|c| c.lemma != lemma),
        "graduated card should not be due anymore at t0+7d"
    );
}

#[tokio::test]
async fn lapse_within_window_blocks_graduation_even_if_reps_reached() {
    let dir = TempDir::new().expect("tempdir");
    let db_path = dir.path().join("wordbrain.db");
    let conn = open(&db_path).await;
    schema::apply(&conn).await.expect("apply schema");

    let t0: i64 = 1_700_000_000_000;
    let lemma = "obstinate";
    add_to_srs_on_conn(&conn, lemma, t0).await.unwrap();

    // Rating 1 = Again (lapse). Then 3× Good — reps would reach 4 but the
    // lapse is inside the LAPSE_WINDOW so graduation is blocked.
    let upd = SchedulingUpdate {
        stability: 1.0,
        difficulty: 6.0,
        elapsed_days: 0,
        scheduled_days: 1,
        due: t0 + DAY_MS,
    };
    apply_rating_on_conn(
        &conn,
        lemma,
        /*Again*/ 1,
        &upd,
        t0,
        DEFAULT_GRADUATION_REPS,
    )
    .await
    .unwrap();

    // Three successful reps, all inside the 14-day lapse window.
    for step in 1..=3 {
        let now = t0 + step * DAY_MS;
        let upd = SchedulingUpdate {
            stability: step as f64,
            difficulty: 5.5,
            elapsed_days: 1,
            scheduled_days: 2,
            due: now + 2 * DAY_MS,
        };
        let out = apply_rating_on_conn(
            &conn,
            lemma,
            RATING_GOOD,
            &upd,
            now,
            DEFAULT_GRADUATION_REPS,
        )
        .await
        .unwrap();
        assert!(
            !out.graduated_to_known,
            "recent lapse must block graduation (step {step})"
        );
    }

    // Word must still be in 'learning' after the blocked graduation.
    let mut rows = conn
        .query(
            "SELECT state FROM words WHERE lemma = ?1",
            turso::params![lemma],
        )
        .await
        .unwrap();
    let row = rows.next().await.unwrap().expect("row");
    let state: String = row.get(0).unwrap();
    assert_eq!(
        state, "learning",
        "lapse within window blocks 'known' promotion"
    );
}

#[tokio::test]
async fn add_to_srs_is_idempotent() {
    let dir = TempDir::new().expect("tempdir");
    let db_path = dir.path().join("wordbrain.db");
    let conn = open(&db_path).await;
    schema::apply(&conn).await.expect("apply schema");

    let t0: i64 = 1_700_000_000_000;
    let first = add_to_srs_on_conn(&conn, "ephemeral", t0).await.unwrap();
    assert!(!first.already_scheduled);

    // Re-adding later should not overwrite the original schedule row.
    let second = add_to_srs_on_conn(&conn, "ephemeral", t0 + 5 * DAY_MS)
        .await
        .unwrap();
    assert!(second.already_scheduled, "second add must short-circuit");
    assert_eq!(second.due, t0, "existing due must not be reset");
}
