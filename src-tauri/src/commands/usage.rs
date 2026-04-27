//! Tauri IPC for the learning-loop telemetry surface.
//!
//! - `register_word_use(word_id, surface)` — atomic +1 on `words.usage_count`,
//!   appends to `word_usage_log`, returns the new counter value.
//! - `recent_practice_words(window_days, limit)` — feed for the Story /
//!   Writing sidebars (level-asc, recency-desc, default 14d / 50 rows).

use crate::db;

#[tauri::command]
pub async fn register_word_use(word_id: i64, surface: String) -> Result<u32, String> {
    db::usage::register_word_use(word_id, &surface)
        .await
        .map_err(|e| format!("register word use: {e}"))
}

#[tauri::command]
pub async fn recent_practice_words(
    window_days: u32,
    limit: u32,
) -> Result<Vec<db::usage::RecentWord>, String> {
    let window = if window_days == 0 { 14 } else { window_days };
    let cap = if limit == 0 { 50 } else { limit };
    db::usage::recent_practice_words(window, cap)
        .await
        .map_err(|e| format!("recent practice words: {e}"))
}
