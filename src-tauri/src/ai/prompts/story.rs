//! Story generation prompt — produces a 120–180 word paragraph with N cloze
//! blanks (one per target word) and 4-option MCQs per blank.
//!
//! Output schema (returned as JSON to the AI chain):
//! ```json
//! {
//!   "story_text": "string (120–180 words, blanks rendered as ____)",
//!   "blanks": [
//!     {
//!       "index": 0,
//!       "target_word": "string",
//!       "options": ["a", "b", "c", "d"],
//!       "correct_index": 0
//!     }
//!   ]
//! }
//! ```

use serde_json::{json, Value};

pub const VERSION: &str = "story.v1";

pub fn build(target_words: &[&str]) -> String {
    let words = target_words.join(", ");
    format!(
        "You are an English teacher writing a short story for a vocabulary \
learner. Compose ONE coherent paragraph between 120 and 180 words that \
naturally exercises every word in this list: [{words}].\n\n\
For each target word, replace its occurrence with the literal token `____` \
(four underscores) and produce a 4-option multiple-choice question. The \
correct answer is the original target word. The three distractors must be \
near-synonyms with the wrong sense, or other plausible English words that \
do not fit the slot.\n\n\
Return ONLY a single JSON object matching this schema (no prose, no \
markdown fences):\n\
{{\"story_text\": string, \"blanks\": [\
{{\"index\": int, \"target_word\": string, \"options\": [string,string,string,string], \"correct_index\": int}}\
]}}\n\n\
Constraints: exactly {n} blanks (one per target word, in the order given), \
the literal token `____` appears exactly {n} times in `story_text`, every \
`correct_index` ∈ [0,3]. Prompt template id: {tpl}.",
        words = words,
        n = target_words.len(),
        tpl = VERSION,
    )
}

/// JSON schema for `claude --json-schema` / `codex --output-schema`.
pub fn schema() -> Value {
    json!({
        "type": "object",
        "required": ["story_text", "blanks"],
        "properties": {
            "story_text": { "type": "string", "minLength": 200 },
            "blanks": {
                "type": "array",
                "minItems": 1,
                "maxItems": 8,
                "items": {
                    "type": "object",
                    "required": ["index", "target_word", "options", "correct_index"],
                    "properties": {
                        "index": { "type": "integer", "minimum": 0 },
                        "target_word": { "type": "string" },
                        "options": {
                            "type": "array",
                            "minItems": 4,
                            "maxItems": 4,
                            "items": { "type": "string" }
                        },
                        "correct_index": { "type": "integer", "minimum": 0, "maximum": 3 }
                    }
                }
            }
        }
    })
}
