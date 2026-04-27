//! Writing-train grading prompt.
//!
//! Grades word-usage primarily, grammar lightly. Returns a meaning-preserving
//! rewrite that keeps the target word, plus inline `[syn1, syn2, …]` spans
//! after the target word for slot-fill alternatives.
//!
//! Output schema:
//! ```json
//! {
//!   "corrected_text": "string",
//!   "diff_spans": [{"from": 0, "to": 5, "kind": "insert|delete|equal", "text": "..."}],
//!   "usage_verdict": "correct|incorrect|ambiguous",
//!   "usage_explanation": "string (known-words-only when verdict=incorrect)",
//!   "synonym_spans": [{"from": 0, "to": 0, "synonyms": ["a","b","c"]}]
//! }
//! ```

use serde_json::{json, Value};

pub const VERSION: &str = "writing_grade.v1";

pub fn build(target_word: &str, raw_text: &str, known_list: &[&str]) -> String {
    let known_csv = known_list.join(", ");
    format!(
        "You are a vocabulary coach. The learner wrote a sentence using the \
target word `{target_word}`. Grade ONLY the use of `{target_word}` in \
context — do not nitpick grammar unless it directly distorts meaning. \
Return a meaning-preserving rewrite that ALWAYS preserves the target word.\n\n\
For the rewrite, append inline `[syn1, syn2, syn3]` immediately after the \
target word listing 2–5 alternative slot-fillers (near-synonyms that would \
also fit grammatically and semantically).\n\n\
For `usage_explanation` (only when verdict is `incorrect` or `ambiguous`): \
HARD CONSTRAINT: every word must appear in this allowlist (case-insensitive, \
inflections OK): [{known_csv}]. Prefer paraphrase to substitution.\n\n\
Original learner text:\n```\n{raw_text}\n```\n\n\
Return ONLY a single JSON object matching this schema (no prose, no fences):\n\
{{\"corrected_text\": string, \"diff_spans\": [{{\"from\": int, \"to\": int, \"kind\": \"insert\"|\"delete\"|\"equal\", \"text\": string}}], \
\"usage_verdict\": \"correct\"|\"incorrect\"|\"ambiguous\", \
\"usage_explanation\": string, \
\"synonym_spans\": [{{\"from\": int, \"to\": int, \"synonyms\": [string]}}]}}\n\n\
Prompt template id: {tpl}.",
        tpl = VERSION,
    )
}

pub fn schema() -> Value {
    json!({
        "type": "object",
        "required": [
            "corrected_text",
            "diff_spans",
            "usage_verdict",
            "usage_explanation",
            "synonym_spans"
        ],
        "properties": {
            "corrected_text": { "type": "string" },
            "diff_spans": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["from", "to", "kind", "text"],
                    "properties": {
                        "from": { "type": "integer", "minimum": 0 },
                        "to": { "type": "integer", "minimum": 0 },
                        "kind": { "type": "string", "enum": ["insert", "delete", "equal"] },
                        "text": { "type": "string" }
                    }
                }
            },
            "usage_verdict": { "type": "string", "enum": ["correct", "incorrect", "ambiguous"] },
            "usage_explanation": { "type": "string" },
            "synonym_spans": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["from", "to", "synonyms"],
                    "properties": {
                        "from": { "type": "integer", "minimum": 0 },
                        "to": { "type": "integer", "minimum": 0 },
                        "synonyms": {
                            "type": "array",
                            "minItems": 0,
                            "maxItems": 5,
                            "items": { "type": "string" }
                        }
                    }
                }
            }
        }
    })
}
