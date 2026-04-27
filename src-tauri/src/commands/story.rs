//! Tauri IPC for the Story Review surface.
//!
//! `generate_story(word_ids)` asks the AI chain (claude-p → codex) to compose
//! a 120–180 word paragraph that exercises the supplied lemmas, persists the
//! result as a `materials` row with `source_kind='ai_story'` plus an
//! `mcq_payload` JSON blob, and returns the renderable shape to the frontend.
//!
//! `generate_mcq_explanation(word_id, wrong, correct, known_lemmas)` returns
//! a 1–2 sentence explanation written using only words from the user's
//! known-set (the prompt enforces this constraint; tokens outside the set are
//! discouraged but not strictly impossible — a verifier test asserts ≥95%).
//!
//! `source_kind` validation lives here, not at the schema layer, because
//! SQLite cannot ALTER a CHECK constraint without rebuilding the table.

use serde::Deserialize;

use crate::ai;
use crate::db;
use crate::db::story::{
    ClozeBlank, StoryHistoryItem, StoryInsertInput, StoryMaterial, SOURCE_KIND_AI_STORY,
};

/// Internal helper: parse the AI's JSON response into a typed shape.
#[derive(Debug, Deserialize)]
struct AiStoryResponse {
    story_text: String,
    blanks: Vec<AiStoryBlank>,
}

#[derive(Debug, Deserialize)]
struct AiStoryBlank {
    // The AI's `index` is advisory; we re-index in document order in
    // `generate_story` so dropping it keeps the parser tolerant. Tag it
    // `#[serde(default)]` so missing-field errors don't kill the response.
    #[serde(default)]
    #[allow(dead_code)]
    index: i64,
    target_word: String,
    options: Vec<String>,
    correct_index: i64,
}

struct ComposedStory {
    title: String,
    story_text_placeholders: String,
    raw_text: String,
    tiptap_json: String,
    mcq_payload: serde_json::Value,
    word_ids: Vec<i64>,
    total_tokens: i64,
    unique_tokens: i64,
    blanks: Vec<ClozeBlank>,
}

/// Count runs of ≥4 underscores in the AI's story body. Each run is one blank
/// regardless of how many extra underscores the AI emitted — the matching
/// logic in [`placeholderize`] collapses the same way.
fn count_underscore_runs(story_text: &str) -> usize {
    let mut count = 0usize;
    let mut chars = story_text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '_' {
            let mut run = 1;
            while let Some(&next) = chars.peek() {
                if next == '_' {
                    run += 1;
                    chars.next();
                } else {
                    break;
                }
            }
            if run >= 4 {
                count += 1;
            }
        }
    }
    count
}

/// Convert literal `____` blanks into `{{N}}` placeholders so the renderer can
/// split deterministically. The N-th `____` (1-based) becomes `{{N}}` regardless
/// of which target word it represents — the renderer pairs the n-th placeholder
/// with `blanks[n-1]` (which we re-index in document order below).
fn placeholderize(story_text: &str) -> String {
    let mut out = String::with_capacity(story_text.len() + 8);
    let mut counter: usize = 0;
    let mut chars = story_text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '_' {
            // Look ahead for a run of ≥4 underscores.
            let mut run = 1;
            while let Some(&next) = chars.peek() {
                if next == '_' {
                    run += 1;
                    chars.next();
                } else {
                    break;
                }
            }
            if run >= 4 {
                counter += 1;
                out.push_str(&format!("{{{{{counter}}}}}"));
                // Drop any extra underscores beyond 4 — keep the prose tidy.
            } else {
                for _ in 0..run {
                    out.push('_');
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

#[tauri::command]
pub async fn generate_story(word_ids: Vec<i64>) -> Result<StoryMaterial, String> {
    let composed = compose_story(&word_ids).await?;
    let input = StoryInsertInput {
        title: &composed.title,
        story_text_placeholders: &composed.story_text_placeholders,
        raw_text: &composed.raw_text,
        tiptap_json: &composed.tiptap_json,
        mcq_payload: &composed.mcq_payload,
        word_ids: &composed.word_ids,
        total_tokens: composed.total_tokens,
        unique_tokens: composed.unique_tokens,
        blanks: &composed.blanks,
    };
    debug_assert_eq!(SOURCE_KIND_AI_STORY, "ai_story");
    db::story::insert_story(&input)
        .await
        .map_err(|e| format!("insert_story: {e}"))
}

#[tauri::command]
pub async fn list_story_history() -> Result<Vec<StoryHistoryItem>, String> {
    db::story::list_story_history()
        .await
        .map_err(|e| format!("list_story_history: {e}"))
}

#[tauri::command]
pub async fn load_story(material_id: i64) -> Result<Option<StoryMaterial>, String> {
    db::story::load_story(material_id)
        .await
        .map_err(|e| format!("load_story: {e}"))
}

#[tauri::command]
pub async fn delete_story(material_id: i64) -> Result<bool, String> {
    db::story::delete_story(material_id)
        .await
        .map_err(|e| format!("delete_story: {e}"))
}

#[tauri::command]
pub async fn regenerate_story(material_id: i64) -> Result<StoryMaterial, String> {
    let word_ids = db::story::story_word_ids(material_id)
        .await
        .map_err(|e| format!("story_word_ids: {e}"))?;
    if word_ids.is_empty() {
        return Err(format!(
            "story material {material_id} has no target words to regenerate"
        ));
    }

    // Compose first. If the AI result violates the story contract, the
    // persisted history row is not touched.
    let composed = compose_story(&word_ids).await?;
    let input = StoryInsertInput {
        title: &composed.title,
        story_text_placeholders: &composed.story_text_placeholders,
        raw_text: &composed.raw_text,
        tiptap_json: &composed.tiptap_json,
        mcq_payload: &composed.mcq_payload,
        word_ids: &composed.word_ids,
        total_tokens: composed.total_tokens,
        unique_tokens: composed.unique_tokens,
        blanks: &composed.blanks,
    };
    debug_assert_eq!(SOURCE_KIND_AI_STORY, "ai_story");
    db::story::replace_story(material_id, &input)
        .await
        .map_err(|e| format!("replace_story: {e}"))
}

async fn compose_story(word_ids: &[i64]) -> Result<ComposedStory, String> {
    if word_ids.is_empty() {
        return Err("word_ids must not be empty".to_string());
    }
    if word_ids.len() > 8 {
        return Err("word_ids cannot exceed 8 (story prompt schema cap)".to_string());
    }

    // 1. Resolve lemmas in input order so the AI sees them in the order the
    //    UI passed them. Missing rows are dropped.
    let resolved = db::story::lookup_words(&word_ids)
        .await
        .map_err(|e| format!("lookup_words: {e}"))?;
    if resolved.is_empty() {
        return Err("no matching words for the supplied ids".to_string());
    }
    let lemmas: Vec<&str> = resolved.iter().map(|(_, l)| l.as_str()).collect();

    // 2. Compose + invoke the AI chain.
    let prompt = ai::prompts::story::build(&lemmas);
    let schema = ai::prompts::story::schema();
    let outcome = ai::ai_call(&prompt, Some(&schema))
        .await
        .map_err(|e| format!("ai_call(story): {e}"))?;
    let parsed = outcome
        .parsed
        .ok_or_else(|| "story AI returned no JSON object".to_string())?;
    let resp: AiStoryResponse =
        serde_json::from_value(parsed).map_err(|e| format!("story parse: {e}"))?;

    // 3a. Validate the AI obeyed the contract: exactly N `____` runs in the
    //     story body, where N == blanks.len(). Mismatches mean the prompt
    //     drifted (length skew, ordering bug, or duplicated blank) and we
    //     surface a clean error so the user can re-roll instead of quietly
    //     pairing the wrong word with the wrong placeholder downstream.
    let underscore_runs = count_underscore_runs(&resp.story_text);
    if underscore_runs != resp.blanks.len() {
        return Err(format!(
            "story AI contract drift: {} `____` runs in body but {} blanks in payload",
            underscore_runs,
            resp.blanks.len()
        ));
    }

    // 3b. Re-index blanks in the *document* order of `____` occurrences so the
    //     rendered placeholder N matches the N-th item in `blanks`. The AI's
    //     own `index` field is advisory; we trust the textual order.
    let mut blanks: Vec<ClozeBlank> = Vec::with_capacity(resp.blanks.len());
    let mut covered_word_ids: Vec<i64> = Vec::with_capacity(resp.blanks.len());
    for (i, b) in resp.blanks.iter().enumerate() {
        // Find the word_id for `target_word` (case-insensitive), defaulting
        // to the i-th supplied id when the AI's spelling drifted.
        let lemma_lower = b.target_word.to_ascii_lowercase();
        let target_word_id = resolved
            .iter()
            .find(|(_, l)| l.eq_ignore_ascii_case(&lemma_lower))
            .map(|(id, _)| *id)
            .or_else(|| word_ids.get(i).copied())
            .ok_or_else(|| format!("blank {i}: cannot resolve target word"))?;

        if b.options.len() != 4 {
            return Err(format!("blank {i}: must have exactly 4 options"));
        }
        if b.correct_index < 0 || b.correct_index > 3 {
            return Err(format!("blank {i}: correct_index out of range"));
        }
        covered_word_ids.push(target_word_id);
        blanks.push(ClozeBlank {
            index: i as i64,
            target_word_id,
            options: b.options.clone(),
            correct_index: b.correct_index,
        });
    }

    // 4. Build the placeholder-bearing renderable + a minimal Tiptap doc.
    let placeholder_text = placeholderize(&resp.story_text);
    let tiptap = serde_json::json!({
        "type": "doc",
        "content": [
            {
                "type": "paragraph",
                "content": [{ "type": "text", "text": placeholder_text }]
            }
        ]
    })
    .to_string();
    let mcq_payload = serde_json::json!({
        "blanks": blanks,
        "prompt_version": ai::prompts::story::VERSION,
    });

    // 5. Lightweight token stats — just for materials.unique_tokens / total.
    let total_tokens = resp.story_text.split_whitespace().count() as i64;
    let unique_tokens: i64 = {
        use std::collections::HashSet;
        let set: HashSet<String> = resp
            .story_text
            .split_whitespace()
            .map(|w| w.to_ascii_lowercase())
            .collect();
        set.len() as i64
    };

    // 6. Persist + return. Title uses the first lemma + a count for at-a-glance
    //    Library scanning. `source_kind` is hardcoded to the validated constant.
    let title = format!(
        "AI Story · {} +{}",
        lemmas[0],
        lemmas.len().saturating_sub(1)
    );
    Ok(ComposedStory {
        title,
        story_text_placeholders: placeholder_text,
        raw_text: resp.story_text,
        tiptap_json: tiptap,
        mcq_payload,
        word_ids: covered_word_ids,
        total_tokens,
        unique_tokens,
        blanks,
    })
}

#[derive(Debug, Deserialize)]
struct AiExplanationResponse {
    explanation: String,
}

#[tauri::command]
pub async fn generate_mcq_explanation(
    word_id: i64,
    wrong_answer_text: String,
    correct_answer_text: String,
    known_lemmas: Vec<String>,
) -> Result<String, String> {
    let resolved = db::story::lookup_words(&[word_id])
        .await
        .map_err(|e| format!("lookup_words: {e}"))?;
    let target_lemma = resolved
        .first()
        .map(|(_, l)| l.clone())
        .unwrap_or_else(|| "<unknown>".to_string());

    // Cap the known list so the prompt stays under ~6 KB. Spec default is 800.
    const KNOWN_CAP: usize = 800;
    let mut bounded: Vec<&str> = known_lemmas
        .iter()
        .take(KNOWN_CAP)
        .map(|s| s.as_str())
        .collect();
    bounded.sort_unstable();
    bounded.dedup();

    let prompt = ai::prompts::mcq_explanation::build(
        &target_lemma,
        wrong_answer_text.trim(),
        correct_answer_text.trim(),
        &bounded,
    );
    let schema = ai::prompts::mcq_explanation::schema();
    let outcome = ai::ai_call(&prompt, Some(&schema))
        .await
        .map_err(|e| format!("ai_call(explanation): {e}"))?;
    let parsed = outcome
        .parsed
        .ok_or_else(|| "explanation AI returned no JSON object".to_string())?;
    let resp: AiExplanationResponse =
        serde_json::from_value(parsed).map_err(|e| format!("explanation parse: {e}"))?;
    Ok(resp.explanation)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholderize_replaces_runs_of_four_underscores() {
        let out = placeholderize("He took the ____ and gave the ____ back.");
        assert_eq!(out, "He took the {{1}} and gave the {{2}} back.");
    }

    #[test]
    fn placeholderize_collapses_runs_longer_than_four() {
        // Six underscores still count as one blank.
        let out = placeholderize("see ______ here");
        assert_eq!(out, "see {{1}} here");
    }

    #[test]
    fn placeholderize_keeps_short_underscore_runs_intact() {
        // Three underscores are not a blank — they could be emphasis or a typo.
        let out = placeholderize("see ___ here");
        assert_eq!(out, "see ___ here");
    }

    #[test]
    fn count_underscore_runs_matches_placeholderize_pairing() {
        assert_eq!(count_underscore_runs("a ____ b ____ c."), 2);
        assert_eq!(count_underscore_runs("nothing here"), 0);
        assert_eq!(count_underscore_runs("___ short ___"), 0);
        assert_eq!(count_underscore_runs("___________"), 1);
    }
}
