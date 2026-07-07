//! IPC surface for the per-word learning profile.

use crate::db::profile::{self, WordProfile};

/// Full learning trail for one lemma — words row, SRS schedule + recent
/// reviews, lookup history, usage telemetry, and every material containing
/// it. `None` when the lemma has no `words` row yet.
#[tauri::command]
pub async fn word_profile(lemma: String) -> Result<Option<WordProfile>, String> {
    profile::word_profile(&lemma).await.map_err(|e| {
        log::error!("word_profile({lemma}) failed: {e}");
        e.to_string()
    })
}
