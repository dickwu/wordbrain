//! Three-tier dictionary IPC:
//!   * `lookup_offline` — bundled ECDICT (≤1 ms after bootstrap).
//!   * `lookup_online`  — Youdao / DeepL via reqwest + `word_translations_cache`.
//!   * `lookup_ai`      — OpenAI / Anthropic / Ollama via reqwest, cached by
//!                        `sha1(context_sentence)`.
//!
//! Every tier writes back into `word_translations_cache` so the second hit is
//! served locally in < 10 ms. API keys are read from `KeyVault` — never from
//! the frontend.

use std::time::{Duration, Instant};

use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha1::{Digest as _, Sha1};
use sha2::Sha256;
use tauri::State;

use crate::db;
use crate::keys::KeyVault;

/// Helper: sha1(s) as a lowercase hex string.
fn sha1_hex(s: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(s.as_bytes());
    hex::encode(hasher.finalize())
}

#[derive(Debug, Clone, Serialize)]
pub struct OfflineLookupResult {
    pub entry: Option<db::dict::OfflineEntry>,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct OnlineLookupResult {
    pub lemma: String,
    pub provider: String,
    pub translation_zh: String,
    pub example: Option<String>,
    pub cached: bool,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct AiLookupResult {
    pub lemma: String,
    pub provider: String,
    pub model: String,
    pub context_hash: String,
    pub translation_zh: String,
    pub cached: bool,
    pub elapsed_ms: u64,
}

// ---------------------------------------------------------------------------
// Offline
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn lookup_offline(lemma: String) -> Result<OfflineLookupResult, String> {
    let start = Instant::now();
    let entry = db::dict::lookup_offline(&lemma)
        .await
        .map_err(|e| format!("lookup_offline: {e}"))?;
    Ok(OfflineLookupResult {
        entry,
        elapsed_ms: start.elapsed().as_millis() as u64,
    })
}

// ---------------------------------------------------------------------------
// Online (Youdao + DeepL)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OnlineProvider {
    Youdao,
    Deepl,
}

impl OnlineProvider {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Youdao => "youdao",
            Self::Deepl => "deepl",
        }
    }
}

#[tauri::command]
pub async fn lookup_online(
    vault: State<'_, KeyVault>,
    lemma: String,
    provider: String,
) -> Result<OnlineLookupResult, String> {
    let start = Instant::now();
    let provider_enum = match provider.to_lowercase().as_str() {
        "youdao" => OnlineProvider::Youdao,
        "deepl" => OnlineProvider::Deepl,
        other => return Err(format!("unknown online provider: {other}")),
    };
    let provider_str = provider_enum.as_str();

    // 1. Cache hit? (context_hash is empty for context-free online lookups.)
    if let Some(row) = db::cache::get_cached(&lemma, provider_str, "")
        .await
        .map_err(|e| format!("read cache: {e}"))?
    {
        return Ok(OnlineLookupResult {
            lemma: row.lemma,
            provider: row.provider,
            translation_zh: row.translation_zh,
            example: row.example,
            cached: true,
            elapsed_ms: start.elapsed().as_millis() as u64,
        });
    }

    // 2. Miss → hit provider. Needs a user-configured API key.
    let key_bytes = vault
        .get(provider_str)
        .await
        .map_err(|e| format!("read api key: {e}"))?;
    let key = key_bytes
        .ok_or_else(|| format!("no {provider_str} API key configured"))?;
    let key = String::from_utf8(key).map_err(|e| format!("api key utf8: {e}"))?;

    let fetched = match provider_enum {
        OnlineProvider::Youdao => fetch_youdao(&lemma, &key).await,
        OnlineProvider::Deepl => fetch_deepl(&lemma, &key).await,
    }
    .map_err(|e| format!("{provider_str} fetch: {e}"))?;

    // 3. Cache + return.
    db::cache::put_cached(
        &lemma,
        provider_str,
        "",
        &fetched.translation_zh,
        fetched.example.as_deref(),
        fetched.raw_response.as_deref(),
    )
    .await
    .map_err(|e| format!("write cache: {e}"))?;

    Ok(OnlineLookupResult {
        lemma: lemma.to_lowercase(),
        provider: provider_str.to_string(),
        translation_zh: fetched.translation_zh,
        example: fetched.example,
        cached: false,
        elapsed_ms: start.elapsed().as_millis() as u64,
    })
}

struct FetchedTranslation {
    translation_zh: String,
    example: Option<String>,
    raw_response: Option<String>,
}

async fn fetch_youdao(lemma: &str, app_key_pair: &str) -> anyhow::Result<FetchedTranslation> {
    // app_key_pair format: "APP_KEY:APP_SECRET" (documented in Settings UI).
    let (app_key, app_secret) = app_key_pair
        .split_once(':')
        .ok_or_else(|| anyhow::anyhow!("youdao key must be 'APP_KEY:APP_SECRET'"))?;
    let salt = {
        let mut b = [0u8; 8];
        rand::thread_rng().fill_bytes(&mut b);
        hex::encode(b)
    };
    let curtime = chrono::Utc::now().timestamp().to_string();
    // Youdao v3 input mangling: first 10 + last 10 chars + total len for long
    // queries, else the raw string.
    let q = lemma;
    let input = if q.chars().count() > 20 {
        let chars: Vec<char> = q.chars().collect();
        let first: String = chars.iter().take(10).collect();
        let last: String = chars.iter().rev().take(10).collect::<String>().chars().rev().collect();
        format!("{first}{}{last}", chars.len())
    } else {
        q.to_string()
    };
    let mut h = <Sha256 as sha2::Digest>::new();
    sha2::Digest::update(&mut h, format!("{app_key}{input}{salt}{curtime}{app_secret}").as_bytes());
    let sign = hex::encode(sha2::Digest::finalize(h));

    let body = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("q", q)
        .append_pair("from", "en")
        .append_pair("to", "zh-CHS")
        .append_pair("appKey", app_key)
        .append_pair("salt", &salt)
        .append_pair("sign", &sign)
        .append_pair("signType", "v3")
        .append_pair("curtime", &curtime)
        .finish();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()?;
    let resp = client
        .post("https://openapi.youdao.com/api")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await?
        .error_for_status()?;
    let body: serde_json::Value = resp.json().await?;
    let error_code = body.get("errorCode").and_then(|v| v.as_str()).unwrap_or("");
    if error_code != "0" {
        return Err(anyhow::anyhow!("youdao errorCode {error_code}"));
    }
    let translation_zh = body
        .get("translation")
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.iter().filter_map(|x| x.as_str()).next())
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            body.get("basic")
                .and_then(|b| b.get("explains"))
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|x| x.as_str())
                        .collect::<Vec<_>>()
                        .join("; ")
                })
                .unwrap_or_default()
        });
    let example = body
        .get("web")
        .and_then(|w| w.as_array())
        .and_then(|arr| arr.first())
        .and_then(|entry| entry.get("value"))
        .and_then(|v| v.as_array())
        .and_then(|xs| xs.first())
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());
    Ok(FetchedTranslation {
        translation_zh,
        example,
        raw_response: Some(body.to_string()),
    })
}

async fn fetch_deepl(lemma: &str, auth_key: &str) -> anyhow::Result<FetchedTranslation> {
    // Free-tier keys end in `:fx` and must hit api-free.deepl.com.
    let endpoint = if auth_key.ends_with(":fx") {
        "https://api-free.deepl.com/v2/translate"
    } else {
        "https://api.deepl.com/v2/translate"
    };
    let body = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("text", lemma)
        .append_pair("source_lang", "EN")
        .append_pair("target_lang", "ZH")
        .finish();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()?;
    let resp = client
        .post(endpoint)
        .header("Authorization", format!("DeepL-Auth-Key {auth_key}"))
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await?
        .error_for_status()?;
    let body: serde_json::Value = resp.json().await?;
    let translation_zh = body
        .get("translations")
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.first())
        .and_then(|t| t.get("text"))
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    Ok(FetchedTranslation {
        translation_zh,
        example: None,
        raw_response: Some(body.to_string()),
    })
}

// ---------------------------------------------------------------------------
// AI (OpenAI / Anthropic / Ollama)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy)]
enum AiProvider {
    Openai,
    Anthropic,
    Ollama,
}

impl AiProvider {
    fn parse(s: &str) -> Option<Self> {
        Some(match s.to_lowercase().as_str() {
            "openai" => Self::Openai,
            "anthropic" => Self::Anthropic,
            "ollama" => Self::Ollama,
            _ => return None,
        })
    }
    fn as_str(self) -> &'static str {
        match self {
            Self::Openai => "openai",
            Self::Anthropic => "anthropic",
            Self::Ollama => "ollama",
        }
    }
}

#[tauri::command]
pub async fn lookup_ai(
    vault: State<'_, KeyVault>,
    lemma: String,
    context_sentence: String,
    provider: String,
    model: String,
) -> Result<AiLookupResult, String> {
    let start = Instant::now();
    let provider_enum = AiProvider::parse(&provider)
        .ok_or_else(|| format!("unknown ai provider: {provider}"))?;
    let provider_str = provider_enum.as_str();
    let context_hash = sha1_hex(&context_sentence);
    let cache_provider = format!("{provider_str}:{model}");

    if let Some(row) = db::cache::get_cached(&lemma, &cache_provider, &context_hash)
        .await
        .map_err(|e| format!("ai cache read: {e}"))?
    {
        return Ok(AiLookupResult {
            lemma: row.lemma,
            provider: provider_str.to_string(),
            model: model.clone(),
            context_hash: row.context_hash,
            translation_zh: row.translation_zh,
            cached: true,
            elapsed_ms: start.elapsed().as_millis() as u64,
        });
    }

    // Ollama does not need a key (local runtime). OpenAI + Anthropic do.
    let api_key = match provider_enum {
        AiProvider::Ollama => None,
        _ => {
            let key = vault
                .get(provider_str)
                .await
                .map_err(|e| format!("read ai key: {e}"))?
                .ok_or_else(|| format!("no {provider_str} API key configured"))?;
            Some(String::from_utf8(key).map_err(|e| format!("key utf8: {e}"))?)
        }
    };

    let translation_zh = match provider_enum {
        AiProvider::Openai => {
            fetch_ai_openai(&lemma, &context_sentence, api_key.as_deref().unwrap_or(""), &model).await
        }
        AiProvider::Anthropic => {
            fetch_ai_anthropic(&lemma, &context_sentence, api_key.as_deref().unwrap_or(""), &model)
                .await
        }
        AiProvider::Ollama => fetch_ai_ollama(&lemma, &context_sentence, &model).await,
    }
    .map_err(|e| format!("ai fetch: {e}"))?;

    db::cache::put_cached(
        &lemma,
        &cache_provider,
        &context_hash,
        &translation_zh,
        Some(&context_sentence),
        None,
    )
    .await
    .map_err(|e| format!("ai cache write: {e}"))?;

    Ok(AiLookupResult {
        lemma: lemma.to_lowercase(),
        provider: provider_str.to_string(),
        model,
        context_hash,
        translation_zh,
        cached: false,
        elapsed_ms: start.elapsed().as_millis() as u64,
    })
}

fn ai_prompt(lemma: &str, context: &str) -> String {
    format!(
        "你是一位英语词汇教师。请基于给定句子里的具体语境，给出单词 `{lemma}` 最贴切的中文释义（不超过 40 字，不要输出英文）。\n句子：{context}\n输出格式：仅输出中文释义本身，不要任何前后缀。"
    )
}

async fn fetch_ai_openai(
    lemma: &str,
    context: &str,
    api_key: &str,
    model: &str,
) -> anyhow::Result<String> {
    let body = serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": "You are a contextual Chinese glossator." },
            { "role": "user",   "content": ai_prompt(lemma, context) }
        ],
        "temperature": 0.2
    });
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()?;
    let resp = client
        .post("https://api.openai.com/v1/chat/completions")
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await?
        .error_for_status()?;
    let body: serde_json::Value = resp.json().await?;
    Ok(body
        .pointer("/choices/0/message/content")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string())
}

async fn fetch_ai_anthropic(
    lemma: &str,
    context: &str,
    api_key: &str,
    model: &str,
) -> anyhow::Result<String> {
    let body = serde_json::json!({
        "model": model,
        "max_tokens": 200,
        "messages": [{ "role": "user", "content": ai_prompt(lemma, context) }]
    });
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()?;
    let resp = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .json(&body)
        .send()
        .await?
        .error_for_status()?;
    let body: serde_json::Value = resp.json().await?;
    Ok(body
        .pointer("/content/0/text")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string())
}

async fn fetch_ai_ollama(lemma: &str, context: &str, model: &str) -> anyhow::Result<String> {
    let body = serde_json::json!({
        "model": model,
        "prompt": ai_prompt(lemma, context),
        "stream": false
    });
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()?;
    let resp = client
        .post("http://127.0.0.1:11434/api/generate")
        .json(&body)
        .send()
        .await?
        .error_for_status()?;
    let body: serde_json::Value = resp.json().await?;
    Ok(body
        .get("response")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string())
}
