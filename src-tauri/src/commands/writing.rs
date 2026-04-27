//! Tauri IPC for the Writing Train surface.
//!
//! `submit_writing(target_word_id, raw_text, tiptap_json)` grades the learner's
//! sentence with `ai::ai_call` (claude-p → codex), persists the submission as a
//! `materials` row with `source_kind = 'writing_submission'`, upserts edges
//! into `word_materials` for the target plus any other recent-list lemmas the
//! learner used, and fires `register_word_use(_, 'writing_train')` once for
//! the target plus once per OTHER recent-list lemma found in `raw_text`
//! (deduped per submission).
//!
//! `source_kind` validation lives here because SQLite cannot ALTER a CHECK
//! constraint without rebuilding the table.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::ai;
use crate::db;
use crate::db::usage::SURFACE_WRITING_TRAIN;
use crate::db::writing::{
    DiffSpan, SynonymSpan, WritingFeedback, WritingInsertInput, SOURCE_KIND_WRITING_SUBMISSION,
};

/// Cap on the known-list size injected into the writing-grade prompt so the
/// prompt budget stays under ~6 KB. Top-N by `freq_rank` ascending so the
/// learner's most-common known words anchor the explanation vocabulary.
const KNOWN_LIST_CAP: u32 = 2_000;

/// Trim raw text to a polite preview length when we use it as the material
/// title, matching the convention of `material-builder.ts::deriveTitle`.
const TITLE_MAX_CHARS: usize = 80;

#[derive(Debug, Deserialize)]
pub struct SubmitWritingInput {
    pub target_word_id: i64,
    pub raw_text: String,
    pub tiptap_json: String,
}

/// Internal mirror of the `writing_grade.v1` JSON schema.
#[derive(Debug, Deserialize)]
struct AiWritingResponse {
    corrected_text: String,
    #[serde(default)]
    diff_spans: Vec<DiffSpan>,
    usage_verdict: String,
    #[serde(default)]
    usage_explanation: String,
    #[serde(default)]
    synonym_spans: Vec<SynonymSpan>,
}

/// Same shape as the IPC return value but with the new usage counter on the
/// target word; serialized as the front-end's `WritingFeedbackIpc`.
#[derive(Debug, Serialize)]
struct WritingFeedbackOut {
    material_id: i64,
    corrected_text: String,
    diff_spans: Vec<DiffSpan>,
    usage_verdict: String,
    usage_explanation: String,
    synonym_spans: Vec<SynonymSpan>,
    new_usage_count: i64,
}

#[tauri::command]
pub async fn submit_writing(input: SubmitWritingInput) -> Result<WritingFeedback, String> {
    let raw_text = input.raw_text.trim().to_string();
    if raw_text.is_empty() {
        return Err("raw_text must not be empty".to_string());
    }
    if raw_text.len() > 4_000 {
        return Err("raw_text too long (cap 4000 chars)".to_string());
    }

    // 1. Resolve the target word.
    let resolved = db::story::lookup_words(&[input.target_word_id])
        .await
        .map_err(|e| format!("lookup target word: {e}"))?;
    let target = resolved
        .first()
        .ok_or_else(|| format!("word_id {} not found", input.target_word_id))?;
    let target_lemma = target.1.clone();

    // 2. Build the known-words allowlist for the explanation prompt.
    let known_owned = db::writing::top_known_by_freq(KNOWN_LIST_CAP)
        .await
        .map_err(|e| format!("top_known_by_freq: {e}"))?;
    let known_refs: Vec<&str> = known_owned.iter().map(|s| s.as_str()).collect();

    // 3. Compose + invoke the AI chain.
    let prompt = ai::prompts::writing_grade::build(&target_lemma, &raw_text, &known_refs);
    let schema = ai::prompts::writing_grade::schema();
    let outcome = ai::ai_call(&prompt, Some(&schema))
        .await
        .map_err(|e| format!("ai_call(writing): {e}"))?;
    let parsed = outcome
        .parsed
        .ok_or_else(|| "writing AI returned no JSON object".to_string())?;
    let resp: AiWritingResponse =
        serde_json::from_value(parsed).map_err(|e| format!("writing parse: {e}"))?;
    if !matches!(
        resp.usage_verdict.as_str(),
        "correct" | "incorrect" | "ambiguous"
    ) {
        return Err(format!(
            "writing AI returned invalid usage_verdict: {}",
            resp.usage_verdict
        ));
    }

    // 4. Detect OTHER recent-list lemmas the learner used. We pull a wide
    //    window so the +1 fires for any practice-queue lemma in the text, not
    //    only the active sidebar slice.
    let recent = db::usage::recent_practice_words(90, 200)
        .await
        .map_err(|e| format!("recent_practice_words: {e}"))?;
    let raw_lower = raw_text.to_ascii_lowercase();
    let mut other_word_ids: Vec<i64> = Vec::new();
    let mut seen_ids: HashSet<i64> = HashSet::new();
    seen_ids.insert(target.0);
    for row in &recent {
        if row.id == target.0 {
            continue;
        }
        if seen_ids.contains(&row.id) {
            continue;
        }
        if !contains_word(&raw_lower, &row.lemma) {
            continue;
        }
        other_word_ids.push(row.id);
        seen_ids.insert(row.id);
    }

    // 5. Persist the submission as a material with source_kind=writing_submission.
    debug_assert_eq!(SOURCE_KIND_WRITING_SUBMISSION, "writing_submission");
    let title = derive_title(&target_lemma, &raw_text);
    let total_tokens = raw_text.split_whitespace().count() as i64;
    let unique_tokens: i64 = {
        let set: HashSet<String> = raw_text
            .split_whitespace()
            .map(|w| {
                w.trim_matches(|c: char| !c.is_alphanumeric())
                    .to_ascii_lowercase()
            })
            .filter(|s| !s.is_empty())
            .collect();
        set.len() as i64
    };

    let mut all_word_ids = vec![target.0];
    all_word_ids.extend(other_word_ids.iter().copied());

    let feedback_payload = serde_json::json!({
        "corrected_text": &resp.corrected_text,
        "diff_spans": &resp.diff_spans,
        "usage_verdict": &resp.usage_verdict,
        "usage_explanation": &resp.usage_explanation,
        "synonym_spans": &resp.synonym_spans,
        "prompt_version": ai::prompts::writing_grade::VERSION,
    });

    let material_id = db::writing::insert_writing(&WritingInsertInput {
        title: &title,
        raw_text: &raw_text,
        corrected_text: &resp.corrected_text,
        tiptap_json: &input.tiptap_json,
        feedback_payload: &feedback_payload,
        word_ids: &all_word_ids,
        total_tokens,
        unique_tokens,
    })
    .await
    .map_err(|e| format!("insert_writing: {e}"))?;

    // 6. Fire +1 for the target. Then +1 for each other recent-list lemma
    //    detected (already deduped). Failures are surfaced as errors — the
    //    submission is already persisted; the user can re-submit to retry.
    let new_usage_count = db::usage::register_word_use(target.0, SURFACE_WRITING_TRAIN)
        .await
        .map_err(|e| format!("register target use: {e}"))? as i64;
    for wid in &other_word_ids {
        db::usage::register_word_use(*wid, SURFACE_WRITING_TRAIN)
            .await
            .map_err(|e| format!("register secondary use: {e}"))?;
    }

    Ok(WritingFeedback {
        material_id,
        corrected_text: resp.corrected_text,
        diff_spans: resp.diff_spans,
        usage_verdict: resp.usage_verdict,
        usage_explanation: resp.usage_explanation,
        synonym_spans: resp.synonym_spans,
        new_usage_count,
    })
}

/// True when `lemma` appears as a whole-word match in the lower-cased text.
/// Tolerant of leading/trailing punctuation but does not split inside words.
fn contains_word(lower_text: &str, lemma: &str) -> bool {
    let needle = lemma.trim().to_ascii_lowercase();
    if needle.is_empty() {
        return false;
    }
    for token in lower_text.split(|c: char| !c.is_alphanumeric()) {
        if token == needle {
            return true;
        }
    }
    false
}

fn derive_title(target_lemma: &str, raw_text: &str) -> String {
    let snippet = raw_text.split('\n').next().unwrap_or(raw_text).trim();
    let clipped: String = snippet.chars().take(TITLE_MAX_CHARS).collect();
    if clipped.is_empty() {
        format!("Writing · {target_lemma}")
    } else {
        format!("Writing · {target_lemma} — {clipped}")
    }
}

// `WritingFeedbackOut` is currently unused but kept for callers that prefer the
// flatter shape. Guard against dead-code warnings in tests.
#[allow(dead_code)]
fn _assert_writing_feedback_out_serializes(_: WritingFeedbackOut) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contains_word_matches_whole_words_only() {
        let text = "she felt great trepidation about the result.";
        assert!(contains_word(text, "trepidation"));
        assert!(!contains_word(text, "trepid"));
        assert!(!contains_word(text, "tion"));
    }

    #[test]
    fn contains_word_handles_punctuation_borders() {
        let text = "trepidation, she said. brilliant!";
        assert!(contains_word(text, "trepidation"));
        assert!(contains_word(text, "brilliant"));
        assert!(contains_word(text, "she"));
    }

    #[test]
    fn contains_word_rejects_empty_needle() {
        assert!(!contains_word("anything", ""));
        assert!(!contains_word("anything", "   "));
    }

    #[test]
    fn derive_title_clips_long_snippets() {
        let lemma = "trepidation";
        let raw =
            "trepidation: the night before the test she could not sleep at all and rolled around";
        let t = derive_title(lemma, raw);
        assert!(t.starts_with("Writing · trepidation — "));
        assert!(t.len() < 200);
    }

    #[test]
    fn derive_title_handles_blank_text() {
        let t = derive_title("alpha", "");
        assert_eq!(t, "Writing · alpha");
    }
}
