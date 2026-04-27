//! Wrong-answer explanation prompt for Story Review MCQs.
//!
//! Every word in the response must come from the user's known-set so the
//! explanation is comprehensible. The known list is capped server-side to
//! the most-frequent N entries (default 800) to fit the prompt budget.

use serde_json::{json, Value};

pub const VERSION: &str = "mcq_explanation.v1";

pub fn build(target_word: &str, chosen: &str, correct: &str, known_list: &[&str]) -> String {
    let known_csv = known_list.join(", ");
    format!(
        "You are explaining a vocabulary mistake using ONLY simple English \
words. The learner picked `{chosen}` but the correct answer was `{correct}` \
for the target word `{target_word}`.\n\n\
Write 1–2 short sentences (max 40 words total) that explain why `{correct}` \
fits and `{chosen}` does not.\n\n\
HARD CONSTRAINT: every word in your explanation must appear in this \
allowlist (case-insensitive, plurals/inflections of allowlisted lemmas \
are OK): [{known_csv}]. If a critical concept needs a word outside the \
list, prefer paraphrase over substitution.\n\n\
Return ONLY a single JSON object: {{\"explanation\": string}}. \
Prompt template id: {tpl}.",
        tpl = VERSION,
    )
}

pub fn schema() -> Value {
    json!({
        "type": "object",
        "required": ["explanation"],
        "properties": {
            "explanation": { "type": "string", "minLength": 1, "maxLength": 400 }
        }
    })
}
