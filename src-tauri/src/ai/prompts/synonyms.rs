//! Stand-alone synonym extraction prompt — used when the writing-grade pass
//! does not return synonym spans for a newly-introduced unknown word.

use serde_json::{json, Value};

pub const VERSION: &str = "synonyms.v1";

pub fn build(target_word: &str, context: &str) -> String {
    format!(
        "Return 3–5 single-word English near-synonyms for `{target_word}` as \
used in this sentence:\n```\n{context}\n```\n\
Return ONLY a JSON object: {{\"synonyms\": [string]}}. Prompt template id: {tpl}.",
        tpl = VERSION,
    )
}

pub fn schema() -> Value {
    json!({
        "type": "object",
        "required": ["synonyms"],
        "properties": {
            "synonyms": {
                "type": "array",
                "minItems": 0,
                "maxItems": 5,
                "items": { "type": "string" }
            }
        }
    })
}
