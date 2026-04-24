//! Known-word lifecycle commands: frequency seeding, hydration, mark/unmark.

use serde::Deserialize;

use crate::db;

#[derive(Debug, Deserialize)]
struct FrequencyEntry {
    /// Each entry is a tuple in JSON: [lemma, rank, raw_count]. serde handles
    /// the `count` field too but we only actually use lemma + rank.
    #[serde(rename = "0")]
    _ignore: Option<()>, // unused; present so the struct is never derived directly
}

/// Top-level shape of `src-tauri/assets/subtlex_us_freq.json`.
#[derive(Debug, Deserialize)]
struct FrequencyPayload {
    #[allow(dead_code)]
    count: u32,
    entries: Vec<(String, u32, u64)>,
}

// Bundle the frequency JSON at compile time so the first launch does not need
// the filesystem layout of the app bundle to include it as an asset.
const FREQ_JSON: &[u8] = include_bytes!("../../assets/subtlex_us_freq.json");

fn parse_frequency() -> Result<FrequencyPayload, String> {
    serde_json::from_slice::<FrequencyPayload>(FREQ_JSON)
        .map_err(|e| format!("parse frequency JSON: {e}"))
}

/// Insert the top `cutoff` ranked lemmas as `state='known'` rows.
/// Returns the number of rows actually inserted (ignores already-present lemmas).
#[tauri::command]
pub async fn seed_known_from_frequency(cutoff: u32) -> Result<u32, String> {
    if cutoff == 0 {
        return Ok(0);
    }
    let payload = parse_frequency()?;
    let take = (cutoff as usize).min(payload.entries.len());
    let slice: Vec<(String, u32)> = payload
        .entries
        .into_iter()
        .take(take)
        .map(|(lemma, rank, _count)| (lemma, rank))
        .collect();

    let inserted = db::words::seed_known_from_frequency(&slice)
        .await
        .map_err(|e| format!("seed words: {e}"))?;

    // Stash cutoff in settings so the wizard does not re-run.
    let value = serde_json::to_string(&cutoff).map_err(|e| e.to_string())?;
    db::settings::set("freq_seed_cutoff", &value)
        .await
        .map_err(|e| format!("save cutoff setting: {e}"))?;
    Ok(inserted)
}

/// Every lemma where `state='known'`. Powers wordStore hydration on startup.
#[tauri::command]
pub async fn get_all_known_lemmas() -> Result<Vec<String>, String> {
    db::words::get_all_known_lemmas()
        .await
        .map_err(|e| format!("get known lemmas: {e}"))
}

#[tauri::command]
pub async fn mark_known(lemma: String, source: Option<String>) -> Result<(), String> {
    db::words::mark_known(&lemma, source.as_deref())
        .await
        .map_err(|e| format!("mark known: {e}"))
}

#[tauri::command]
pub async fn unmark_known(lemma: String) -> Result<(), String> {
    db::words::unmark_known(&lemma)
        .await
        .map_err(|e| format!("unmark known: {e}"))
}

#[tauri::command]
pub async fn count_known() -> Result<u64, String> {
    db::words::count_known()
        .await
        .map_err(|e| format!("count known: {e}"))
}

#[tauri::command]
pub async fn list_words(
    filter: db::words::ListWordsFilter,
) -> Result<Vec<db::words::WordRecord>, String> {
    db::words::list_words(&filter)
        .await
        .map_err(|e| format!("list words: {e}"))
}

#[tauri::command]
pub async fn bulk_unmark_known(lemmas: Vec<String>) -> Result<u64, String> {
    db::words::bulk_unmark_known(&lemmas)
        .await
        .map_err(|e| format!("bulk unmark known: {e}"))
}

#[tauri::command]
pub async fn set_word_state(lemma: String, state: String) -> Result<(), String> {
    db::words::set_word_state(&lemma, &state)
        .await
        .map_err(|e| format!("set word state: {e}"))
}

#[tauri::command]
pub async fn set_user_note(lemma: String, note: Option<String>) -> Result<(), String> {
    db::words::set_user_note(&lemma, note.as_deref())
        .await
        .map_err(|e| format!("set user note: {e}"))
}

/// Preview slice for the onboarding slider: returns (rank, lemma) pairs for
/// ranks around the requested cutoff so the wizard can show "≈X% unknown".
#[tauri::command]
pub async fn frequency_preview(cutoff: u32) -> Result<Vec<(u32, String)>, String> {
    let payload = parse_frequency()?;
    let take = (cutoff as usize).min(payload.entries.len());
    let mut out = Vec::with_capacity(take.min(12));
    // Return 6 words just below and just above the cutoff for the UI.
    let lo = take.saturating_sub(3);
    let hi = (take + 3).min(payload.entries.len());
    for (lemma, rank, _count) in payload.entries.into_iter().take(hi).skip(lo) {
        out.push((rank, lemma));
    }
    Ok(out)
}

#[allow(dead_code)]
fn _assert_frequency_unused(_: FrequencyEntry) {}
