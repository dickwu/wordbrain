//! IPC surface for whole-loop learning statistics (Learning hub dashboard).

use crate::db::stats::{self, LearningStats};

/// Aggregate stats for the Learning hub. `days` bounds the review-activity
/// strip (default 14); `tz_offset_minutes` is the caller's local-time offset
/// from UTC in minutes (JS: `-new Date().getTimezoneOffset()`).
#[tauri::command]
pub async fn learning_stats(
    days: Option<u32>,
    tz_offset_minutes: Option<i64>,
) -> Result<LearningStats, String> {
    stats::learning_stats(days.unwrap_or(14), tz_offset_minutes.unwrap_or(0))
        .await
        .map_err(|e| {
            log::error!("learning_stats failed: {e}");
            e.to_string()
        })
}
