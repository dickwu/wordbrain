//! Tauri IPC surface for Phase-4 FSRS review queue.
//!
//! The ts-fsrs scheduler lives on the renderer — these commands just
//! persist whatever stability / difficulty / due values the frontend
//! computed after rating a card, plus enforce the graduation rule.

use crate::db;
use crate::db::srs::{
    AddToSrsOutcome, ApplyRatingOutcome, DueCard, SchedulingUpdate, DEFAULT_GRADUATION_REPS,
};

/// Add a lemma to the FSRS queue with ts-fsrs defaults (stability=0,
/// difficulty=5, due=now). Returns the schedule state after the insert.
/// Idempotent — re-adding a scheduled word is a no-op.
#[tauri::command]
pub async fn add_to_srs(lemma: String) -> Result<AddToSrsOutcome, String> {
    db::srs::add_to_srs(&lemma)
        .await
        .map_err(|e| format!("add_to_srs: {e}"))
}

/// Check whether a lemma is already scheduled in FSRS.
#[tauri::command]
pub async fn is_in_srs(lemma: String) -> Result<bool, String> {
    db::srs::is_in_srs(&lemma)
        .await
        .map_err(|e| format!("is_in_srs: {e}"))
}

/// List every card whose `due <= now_override || now()`. An explicit
/// `now_override` lets integration tests drive the queue with a simulated
/// clock without having to reach into the system time.
#[tauri::command]
pub async fn list_due_srs(now_override: Option<i64>) -> Result<Vec<DueCard>, String> {
    let now = now_override.unwrap_or_else(db::now_ms);
    db::srs::list_due(now)
        .await
        .map_err(|e| format!("list_due_srs: {e}"))
}

/// Live count of rows in `srs_schedule` whose `due <= now`. Drives the
/// sidebar due-queue badge.
#[tauri::command]
pub async fn count_due_srs(now_override: Option<i64>) -> Result<i64, String> {
    let now = now_override.unwrap_or_else(db::now_ms);
    db::srs::count_due(now)
        .await
        .map_err(|e| format!("count_due_srs: {e}"))
}

/// Persist one review: overwrite the schedule row with the ts-fsrs-computed
/// update, append a `srs_review_log` entry, and auto-promote the word to
/// `state='known', state_source='srs'` if the graduation criteria are met.
#[tauri::command]
pub async fn apply_srs_rating(
    lemma: String,
    rating: i64,
    update: SchedulingUpdate,
    now_override: Option<i64>,
    graduation_reps: Option<i64>,
) -> Result<ApplyRatingOutcome, String> {
    let now = now_override.unwrap_or_else(db::now_ms);
    let reps = graduation_reps.unwrap_or(DEFAULT_GRADUATION_REPS).max(1);
    db::srs::apply_rating(&lemma, rating, &update, now, reps)
        .await
        .map_err(|e| format!("apply_srs_rating: {e}"))
}
